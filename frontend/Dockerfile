# Frontend image: static files served by unprivileged nginx, /api proxied to the backend.
# Build context: ./frontend
#   docker build -t spec-demo-frontend --build-arg APP_VERSION=1.0.0 --build-arg GIT_SHA=$(git rev-parse --short HEAD) frontend
FROM nginxinc/nginx-unprivileged:1.27-alpine

ARG APP_VERSION=dev
ARG GIT_SHA=local
ARG BUILD_TIME=unknown

LABEL org.opencontainers.image.title="spec-demo-frontend" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}"

ENV BACKEND_URL=http://backend:3000

USER root
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY public/ /usr/share/nginx/html/

# Stamp the build so the UI can show which frontend version is being served.
# Static content stays root-owned and read-only for the nginx user.
RUN printf '{"service":"frontend","version":"%s","commit":"%s","buildTime":"%s"}\n' \
      "${APP_VERSION}" "${GIT_SHA}" "${BUILD_TIME}" > /usr/share/nginx/html/version.json \
 && chmod -R a+rX /usr/share/nginx/html /etc/nginx/snippets
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
