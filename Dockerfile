FROM node:20-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* index.js ./
RUN npm install

COPY . .

ENTRYPOINT ["node", "index.js"]