#!/usr/bin/env bash
# One-time import of the console-created CloudFront logging delivery into the
# cloudfront-logging stack (us-east-1). Creates a change set and shows it; it
# does NOT execute it. Review the output, then run the printed execute command.
#
# After the import, change the template and use:
#   aws cloudformation deploy --region us-east-1 --stack-name cloudfront-logging \
#     --template-file infra/cloudfront-logging.yaml --parameter-overrides ...
set -euo pipefail

REGION=us-east-1
STACK=cloudfront-logging
CHANGE_SET=import-existing-delivery
TEMPLATE="$(dirname "$0")/cloudfront-logging.yaml"

DISTRIBUTION_ID=E1Z5N5X273TPT1
LOGS_BUCKET=post-tenebras-lire-access-logs
DESTINATION_NAME=CF-E1Z5N5X273TPT1-post-tenebras-lire-access-lo-1776799920067
DELIVERY_ID=8T56FbbIZZfqU6sj
SOURCE_NAME="CreatedByCloudFront-${DISTRIBUTION_ID}"

aws cloudformation create-change-set \
  --region "$REGION" \
  --stack-name "$STACK" \
  --change-set-name "$CHANGE_SET" \
  --change-set-type IMPORT \
  --template-body "file://${TEMPLATE}" \
  --parameters \
    ParameterKey=DistributionId,ParameterValue="$DISTRIBUTION_ID" \
    ParameterKey=LogsBucket,ParameterValue="$LOGS_BUCKET" \
    ParameterKey=DeliveryDestinationName,ParameterValue="$DESTINATION_NAME" \
  --resources-to-import "[
    {\"ResourceType\":\"AWS::Logs::DeliverySource\",\"LogicalResourceId\":\"LogDeliverySource\",\"ResourceIdentifier\":{\"Name\":\"${SOURCE_NAME}\"}},
    {\"ResourceType\":\"AWS::Logs::DeliveryDestination\",\"LogicalResourceId\":\"LogDeliveryDestination\",\"ResourceIdentifier\":{\"Name\":\"${DESTINATION_NAME}\"}},
    {\"ResourceType\":\"AWS::Logs::Delivery\",\"LogicalResourceId\":\"LogDelivery\",\"ResourceIdentifier\":{\"DeliveryId\":\"${DELIVERY_ID}\"}}
  ]"

aws cloudformation wait change-set-create-complete \
  --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"

aws cloudformation describe-change-set \
  --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
  --query '{Status:Status,Changes:Changes[].ResourceChange.{Action:Action,Id:LogicalResourceId,Type:ResourceType}}'

cat <<EOF

Expected: three Import actions and nothing else. If so, execute with:

  aws cloudformation execute-change-set --region $REGION \\
    --stack-name $STACK --change-set-name $CHANGE_SET

Then check for drift (the imported properties must match the template):

  aws cloudformation detect-stack-drift --region $REGION --stack-name $STACK
EOF
