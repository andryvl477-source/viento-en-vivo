# Imagen base con Node.js
FROM node:20-slim

# Instala Java JDK (para compilar), Maven (para compilar grib2json) y Git
# (para descargar su codigo fuente). grib2json no tiene un binario ya
# compilado para descargar -- hay que armarlo desde el codigo cada vez.
RUN apt-get update \
    && apt-get install -y --no-install-recommends default-jdk maven git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Descarga y compila grib2json desde su repositorio oficial
RUN git clone https://github.com/cambecc/grib2json.git \
    && cd grib2json \
    && mvn package -q -DskipTests \
    && mkdir -p /opt/grib2json \
    && tar -xzf target/grib2json-*.tar.gz -C /opt/grib2json --strip-components=1

WORKDIR /app

# Copia primero package.json para aprovechar el cache de Docker
COPY package*.json ./
RUN npm install --production

# Copia el resto del proyecto (tu app.js, etc.)
COPY . .

# Coloca el grib2json ya compilado justo donde tu app.js lo espera
# (converter/bin/grib2json) y lo hace ejecutable
RUN mkdir -p converter \
    && cp -r /opt/grib2json/bin /opt/grib2json/lib converter/ \
    && chmod +x converter/bin/grib2json

EXPOSE 10000
ENV PORT=10000
# El script de grib2json necesita saber donde esta Java instalado
ENV JAVA_HOME=/usr/lib/jvm/default-java

CMD ["node", "app.js"]
