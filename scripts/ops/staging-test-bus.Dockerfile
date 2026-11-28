FROM node:22-bookworm
USER node
WORKDIR /home/node
ARG BUS_VERSION
ARG BUS_INTEGRITY
RUN npm install --ignore-scripts --registry https://registry.npmjs.org "@open-artifacts/bus@${BUS_VERSION}" \
    && node -e 'const entries=require("./package-lock.json").packages; const p=entries["node_modules/@open-artifacts/bus"]; if(Object.keys(entries).length !== 2 || p?.version !== process.env.BUS_VERSION || p?.integrity !== process.env.BUS_INTEGRITY) throw Error("bus release pin mismatch")' \
    && npm audit signatures
ENV PATH="/home/node/node_modules/.bin:${PATH}"
RUN mkdir -m 700 /home/node/.oa-bus
CMD ["oa-bus", "daemon"]
