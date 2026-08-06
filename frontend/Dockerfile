FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_BFF_URL=http://localhost:3000
ARG VITE_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
ENV VITE_BFF_URL=$VITE_BFF_URL
ENV VITE_OTEL_EXPORTER_OTLP_ENDPOINT=$VITE_OTEL_EXPORTER_OTLP_ENDPOINT
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
