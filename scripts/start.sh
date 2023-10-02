#!/usr/bin/env bash

set -e -o pipefail

# Get application environment from EC2 instance tag
TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
APP_ENV=$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/tags/instance/Environment | tr '[:upper:]' '[:lower:]')

case $APP_ENV in
  "test")
    APP_ENV=test;;
  dev*)
    APP_ENV=dev;;
  prod*)
    APP_ENV=prod;;
esac

DB_CREDS_SECRET_ID=/spring-pet-clinic/db/${APP_ENV}

# Retrieve database credentials and endpoint from Secrets Manager
DB_CREDS=$(aws secretsmanager get-secret-value --secret-id ${DB_CREDS_SECRET_ID} --query SecretString --output text)

export MYSQL_URL="jdbc:mysql://$(echo $DB_CREDS | jq -r '.host')/petclinic"
export MYSQL_USER=$(echo $DB_CREDS | jq -r '.username')
export MYSQL_PASS=$(echo $DB_CREDS | jq -r '.password')

exec /usr/bin/java -Dspring.profiles.active=mysql -jar /app/spring-pet-clinic/*.jar
