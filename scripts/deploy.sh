#!/usr/bin/env bash
# Build and publish to S3 + CloudFront.
set -euo pipefail

BUCKET="${BUCKET:-eclipse-hammantlabs-site}"
DIST_ID="${DIST_ID:-}"

BASE_PATH=/ npm run build

# Hashed asset filenames are immutable — cache them hard.
aws s3 sync dist/ "s3://$BUCKET/" --delete \
  --exclude "index.html" --exclude "*.map" \
  --cache-control "public,max-age=31536000,immutable" --only-show-errors

# index.html must revalidate or a deploy never reaches returning visitors.
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "public,max-age=0,must-revalidate" \
  --content-type "text/html; charset=utf-8" --only-show-errors

if [ -n "$DIST_ID" ]; then
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/" "/index.html" >/dev/null
  echo "Invalidated CloudFront $DIST_ID"
fi
echo "Deployed to https://eclipse.hammantlabs.com/"
