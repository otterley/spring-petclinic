#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PetClinicStack } from '../lib/pet-clinic-stack';

const app = new cdk.App();
new PetClinicStack(app, 'PetClinicStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});