ARG BASE_IMAGE=cloud-agents-sandbox:0.1.0
FROM ${BASE_IMAGE}
ARG WRANGLER_VERSION=4.156.1
ARG GCLOUD_VERSION=591.0.0-0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gnupg netcat-openbsd libnss-wrapper \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
       | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main' \
       > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       google-cloud-cli=${GCLOUD_VERSION} \
       google-cloud-cli-gke-gcloud-auth-plugin=${GCLOUD_VERSION} \
       kubectl=1:${GCLOUD_VERSION} \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g wrangler@${WRANGLER_VERSION} \
    && ln -s "$(dpkg-query -L libnss-wrapper | sed -n '/\/libnss_wrapper.so$/p')" /opt/cloud-agents/libnss_wrapper.so
ENV CLOUDSDK_CORE_DISABLE_PROMPTS=1 CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK=1
COPY --chmod=755 sandbox/entrypoint.sh sandbox/askpass.sh /opt/cloud-agents/
USER 1000:1000
