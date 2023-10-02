#!/usr/bin/env bash

# Give app a little while to initialize
sleep 30
systemctl is-active spring-pet-clinic.service
