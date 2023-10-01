#!/bin/bash

set -evx -o pipefail

if systemctl is-active --quiet spring-pet-clinic.service; then
  systemctl stop spring-pet-clinic.service
fi
