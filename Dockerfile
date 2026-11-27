FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir "fastapi==0.115.*" "uvicorn==0.32.*" "psycopg[binary,pool]==3.2.*" "webauthn==2.*" \
      "pywebpush==2.0.*" \
    && useradd --system --uid 10001 app

WORKDIR /srv
COPY app ./app
COPY static ./static

USER app
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
