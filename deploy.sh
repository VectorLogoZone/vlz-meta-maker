#!/bin/bash

set -o errexit
set -o pipefail
set -o nounset

export $(cat .env)

docker build -t vlz-metamaker .
docker tag vlz-metamaker:latest gcr.io/vectorlogozone/metamaker:latest
docker push gcr.io/vectorlogozone/metamaker:latest

gcloud beta run deploy vlz-metamaker \
	--image gcr.io/vectorlogozone/metamaker \
	--memory 512M \
	--platform managed \
	--project vectorlogozone \
    --region us-central1 \
	--update-env-vars "COMMIT=$(git rev-parse --short HEAD),LASTMOD=$(date -u +%Y-%m-%dT%H:%M:%SZ),S3_ACCESS_KEY=${S3_ACCESS_KEY},S3_SECRET_KEY=${S3_SECRET_KEY},S3_BUCKET=${S3_BUCKET}"