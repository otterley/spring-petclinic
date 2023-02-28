#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PetClinicStack } from '../lib/pet-clinic-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();
const testStack = new PetClinicStack(app, 'PetClinicTestStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  deployEnv: 'test'
})
const prodStack = new PetClinicStack(app, 'PetClinicProdStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  deployEnv: 'prod'
})
new PipelineStack(app, 'PipelineStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  testCluster: testStack.cluster,
  testDatabase: testStack.database,
  prodCluster: prodStack.cluster,
  prodDatabase: prodStack.database
})