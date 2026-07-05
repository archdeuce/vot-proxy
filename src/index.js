import Fastify from "fastify";
import { fetch, Headers, Request } from "undici";

const fastify = Fastify({ logger: true });
const PORT = process.env.PORT || 4000;

const version = "1.0.17-node";
const yandexUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 YaBrowser/25.4.0.0 Safari/537.36";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, GET, PUT, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const s3Urls = {
  audio: "vtrans.s3-private.mds.yandex.net/tts/prod/",
  subs: "brosubs.s3-private.mds.yandex.net/vtrans/",
};

// Глобальный обработчик CORS для Fastify
fastify.addHook("onRequest", async (request, reply) => {
  for (const [key, value] of Object.entries(corsHeaders)) {
    reply.header(key, value);
  }
});

// Эндпоинт проверки работоспособности
fastify.get("/health", async (request, reply) => {
  reply.header("Content-Type", "application/json");
  return { status: "ok", version };
});

async function makeYandexRequest(request, pathname, method) {
  let requestInfo;
  try {
    requestInfo = JSON.parse(request.body);
  } catch {
    return { status: 400, body: "Bad Request" };
  }

  if (!requestInfo.headers || !requestInfo.body) {
    return { status: 204, yandexStatus: "error-request" };
  }

  // Сохраняем оригинальные заголовки от расширения, но приводим Host и UA к эталону
  const cleanHeaders = { ...requestInfo.headers };

  // Удаляем старый хост в любом регистре и пишем правильный
  Object.keys(cleanHeaders).forEach((key) => {
    if (key.toLowerCase() === "host") delete cleanHeaders[key];
  });
  cleanHeaders["Host"] = "api.browser.yandex.ru";
  cleanHeaders["User-Agent"] = yandexUserAgent;

  try {
    const yandexResponse = await fetch(
      "https://api.browser.yandex.ru" + pathname,
      {
        method: method,
        headers: cleanHeaders,
        body: new Uint8Array(requestInfo.body),
      },
    );

    // ВЫВОД В КОНСОЛЬ ДЛЯ ДЕБАГА
    console.log(
      `[Yandex API] ${method} ${pathname} -> Status: ${yandexResponse.status}`,
    );

    const responseBuffer = await yandexResponse.arrayBuffer();

    return {
      status: yandexResponse.status, // Пробрасываем реальный статус (400, 403, 200 и т.д.)
      yandexStatus:
        yandexResponse.status === 200 ? "success" : "error-yandex-api",
      contentType: yandexResponse.headers.get("content-type"),
      body: Buffer.from(responseBuffer),
    };
  } catch (err) {
    console.error(`[Yandex API] Fetch crashed:`, err.message);
    return { status: 500, body: `Fetch error: ${err.message}` };
  }
}

async function handleS3ProxyRequest(type, urlPath, urlSearch) {
  if (!urlSearch) return { status: 204, yandexStatus: "error-request" };

  const fileName = urlPath.split("/").slice(3).join("/");
  const targetUrl = `https://${s3Urls[type]}${fileName}${urlSearch}`;

  const s3Response = await fetch(targetUrl, {
    headers: { "User-Agent": yandexUserAgent },
  });

  const responseBuffer = await s3Response.arrayBuffer();
  return {
    status: 200,
    yandexStatus: "success",
    contentType: s3Response.headers.get("content-type"),
    body: Buffer.from(responseBuffer),
  };
}

async function handleYAJSONRequest(request, pathname) {
  let requestInfo;
  try {
    requestInfo = JSON.parse(request.body);
  } catch {
    return { status: 400, body: "Bad Request" };
  }

  if (!requestInfo.headers || !requestInfo.body) {
    return { status: 204, yandexStatus: "error-request" };
  }

  const cleanHeaders = { ...requestInfo.headers };
  Object.keys(cleanHeaders).forEach((key) => {
    if (key.toLowerCase() === "host") delete cleanHeaders[key];
  });
  cleanHeaders["Host"] = "api.browser.yandex.ru";
  cleanHeaders["User-Agent"] = yandexUserAgent;

  try {
    const jsonResponse = await fetch(
      `https://api.browser.yandex.ru${pathname}`,
      {
        method: "PUT",
        headers: cleanHeaders,
        body:
          typeof requestInfo.body === "string"
            ? requestInfo.body
            : JSON.stringify(requestInfo.body),
      },
    );

    console.log(
      `[Yandex JSON] PUT ${pathname} -> Status: ${jsonResponse.status}`,
    );

    const responseBuffer = await jsonResponse.arrayBuffer();
    return {
      status: jsonResponse.status, // Пробрасываем реальный статус
      yandexStatus:
        jsonResponse.status === 200 ? "success" : "error-yandex-json",
      contentType: jsonResponse.headers.get("content-type"),
      body: Buffer.from(responseBuffer),
    };
  } catch (err) {
    console.error(`[Yandex JSON] Fetch crashed:`, err.message);
    return { status: 500, body: `Fetch error: ${err.message}` };
  }
}

// Главный роутер, повторяющий логику воркера
fastify.all("/*", async (request, reply) => {
  if (request.method === "OPTIONS") {
    reply.header("Allow", "GET, POST, PUT, OPTIONS");
    return reply.code(204).send();
  }

  const urlPath = request.routerPath || request.url.split("?")[0];
  const urlSearch = request.url.includes("?")
    ? request.url.substring(request.url.indexOf("?"))
    : "";

  const yandexEndpoints = [
    "/video-translation/translate",
    "/video-translation/cache",
    "/video-subtitles/get-subtitles",
    "/stream-translation/translate-stream",
    "/stream-translation/ping-stream",
    "/session/create",
  ];

  if (yandexEndpoints.includes(urlPath)) {
    if (request.method !== "POST")
      return reply.code(204).header("X-Yandex-Status", "error-method").send();
    const result = await makeYandexRequest(request, urlPath, "POST");
    if (result.yandexStatus)
      reply.header("X-Yandex-Status", result.yandexStatus);
    if (result.contentType) reply.header("Content-Type", result.contentType);
    return reply.code(result.status).send(result.body);
  }

  if (urlPath === "/video-translation/audio") {
    if (request.method !== "PUT")
      return reply.code(204).header("X-Yandex-Status", "error-method").send();
    const result = await makeYandexRequest(request, urlPath, "PUT");
    if (result.yandexStatus)
      reply.header("X-Yandex-Status", result.yandexStatus);
    if (result.contentType) reply.header("Content-Type", result.contentType);
    return reply.code(result.status).send(result.body);
  }

  if (urlPath === "/video-translation/fail-audio-js") {
    if (request.method !== "PUT")
      return reply.code(204).header("X-Yandex-Status", "error-method").send();
    const result = await handleYAJSONRequest(request, urlPath);
    if (result.yandexStatus)
      reply.header("X-Yandex-Status", result.yandexStatus);
    if (result.contentType) reply.header("Content-Type", result.contentType);
    return reply.code(result.status).send(result.body);
  }

  if (
    urlPath.startsWith("/video-translation/audio-proxy") &&
    urlPath.endsWith(".mp3")
  ) {
    if (request.method !== "GET")
      return reply.code(204).header("X-Yandex-Status", "error-method").send();
    const result = await handleS3ProxyRequest("audio", urlPath, urlSearch);
    if (result.yandexStatus)
      reply.header("X-Yandex-Status", result.yandexStatus);
    if (result.contentType) reply.header("Content-Type", result.contentType);
    return reply.code(result.status).send(result.body);
  }

  if (urlPath.startsWith("/video-subtitles/subtitles-proxy")) {
    if (request.method !== "GET")
      return reply.code(204).header("X-Yandex-Status", "error-method").send();
    const result = await handleS3ProxyRequest("subs", urlPath, urlSearch);
    if (result.yandexStatus)
      reply.header("X-Yandex-Status", result.yandexStatus);
    if (result.contentType) reply.header("Content-Type", result.contentType);
    return reply.code(result.status).send(result.body);
  }

  return reply.code(204).header("X-Yandex-Status", "error-path").send();
});

// Запуск сервера
const start = async () => {
  try {
    // Включаем прием сырого текста/json для парсинга внутри функций
    fastify.addContentTypeParser(
      "*",
      { parseAs: "string" },
      (req, body, done) => {
        done(null, body);
      },
    );

    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server handling VOT requests on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
