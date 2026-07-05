# Настройка реверс-прокси в Nginx

## Шаг 1: Создание конфигурационного файла

Откройте файл конфигурации Nginx для вашего сайта:

```bash
sudo nano /etc/nginx/sites-available/vot-proxy
```

Вставьте следующую конфигурацию:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Шаг 2: Создание символической ссылки

Создайте символическую ссылку в директории `sites-enabled`:

```bash
sudo ln -s /etc/nginx/sites-available/vot-proxy /etc/nginx/sites-enabled/
```

Проверьте, что ссылка создана:

```bash
ls -l /etc/nginx/sites-enabled/
```

## Шаг 3: Проверка конфигурации

Проверьте корректность конфигурации Nginx:

```bash
sudo nginx -t
```

## Шаг 4: Перезапуск Nginx

Перезагрузите Nginx, чтобы применить изменения:

```bash
sudo systemctl reload nginx
```
