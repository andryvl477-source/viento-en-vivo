# Imagen base con Node.js
FROM node:20-slim

# Instala Java (JRE) — lo necesita la herramienta grib2json para convertir
# los archivos GRIB2 de NOAA a JSON. Sin esto, sale el error
# "converter/bin/grib2json: not found" o fallos internos del script.
RUN apt-get update \
    && apt-get install -y --no-install-recommends default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia primero package.json para aprovechar el cache de Docker
COPY package*.json ./
RUN npm install --production

# Copia el resto del proyecto (incluye app.js y la carpeta converter/)
COPY . .

# Asegura que el script de grib2json sea ejecutable
RUN chmod +x converter/bin/grib2json || true

EXPOSE 10000
ENV PORT=10000

CMD ["node", "app.js"]
