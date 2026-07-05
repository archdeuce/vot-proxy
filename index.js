import Fastify from "fastify";
import { fetch, Headers, Request } from "undici";

const fastify = Fastify({ logger: true });
const PORT = process.env.PORT || 3000;

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

  const yandexResponse = await fetch(
    "https://api.browser.yandex.ru" + pathname,
    {
      method: method,
      headers: requestInfo.headers,
      body: new Uint8Array(requestInfo.body),
    },
  );

  const responseBuffer = await yandexResponse.arrayBuffer();
  return {
    status: 200,
    yandexStatus: "success",
    contentType: yandexResponse.headers.get("content-type"),
    body: Buffer.from(responseBuffer),
  };
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

  const jsonResponse = await fetch(`https://api.browser.yandex.ru${pathname}`, {
    method: "PUT",
    headers: {
      "User-Agent": yandexUserAgent,
      "Content-Type": "application/json",
      ...requestInfo.headers,
    },
    body: JSON.stringify(requestInfo.body),
  });

  const responseBuffer = await jsonResponse.arrayBuffer();
  return {
    status: 200,
    yandexStatus: "success",
    contentType: jsonResponse.headers.get("content-type"),
    body: Buffer.from(responseBuffer),
  };
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
