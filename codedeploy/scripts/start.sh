#!/bin/bash

set -evx -o pipefail

systemctl enable spring-pet-clinic.service
systemctl start spring-pet-clinic.service
