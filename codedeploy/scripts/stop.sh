#!/bin/bash

if systemctl is-active --quiet spring-pet-clinic.service; then
  systemctl stop spring-pet-clinic.service
fi
