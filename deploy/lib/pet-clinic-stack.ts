import * as cdk from 'aws-cdk-lib'
import { type Construct } from 'constructs'
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import * as eks from 'aws-cdk-lib/aws-eks'
import * as kms from 'aws-cdk-lib/aws-kms'
import { AlbControllerVersion, CoreDnsComputeType } from 'aws-cdk-lib/aws-eks'
import { KubectlV24Layer } from '@aws-cdk/lambda-layer-kubectl-v24'
//import * as cdk8s from 'cdk8s'
import { Pipeline, Artifact } from 'aws-cdk-lib/aws-codepipeline'
import { CodeStarConnectionsSourceAction, CodeBuildAction } from 'aws-cdk-lib/aws-codepipeline-actions'
import * as connections from 'aws-cdk-lib/aws-codestarconnections'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import { Repository } from 'aws-cdk-lib/aws-ecr'
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild'
import { Effect, ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { CfnOutput } from 'aws-cdk-lib'

export class PetClinicStack extends cdk.Stack {
  constructor (scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24
        },
        {
          name: 'private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 19
        }
      ]
    })

    const cluster = new eks.Cluster(this, 'Cluster', {
      version: eks.KubernetesVersion.V1_24,
      secretsEncryptionKey: new kms.Key(this, 'ClusterEncryptionKey'),
      coreDnsComputeType: CoreDnsComputeType.FARGATE,
      defaultCapacity: 0,
      vpc,
      vpcSubnets: [{ subnetType: SubnetType.PRIVATE_WITH_EGRESS }],
      kubectlLayer: new KubectlV24Layer(this, 'KubectlV24Layer'),
      albController: {
        version: AlbControllerVersion.V2_4_1
      },
    })
    new CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName
    })

    cluster.addFargateProfile('Karpenter', {
      selectors: [{ namespace: 'karpenter' }]
    })
    cluster.addFargateProfile('System', {
      selectors: [{ namespace: 'kube-system' }]
    })

    const karpenterNamespace = cluster.addManifest('Karpenter', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'karpenter',
        labels: {
          name: 'karpenter'
        }
      }
    });
    const karpenterServiceAccount = cluster.addServiceAccount('Karpenter', {
      namespace: 'karpenter',
      name: 'karpenter'
    });
    karpenterServiceAccount.node.addDependency(karpenterNamespace);
    karpenterServiceAccount.role.addManagedPolicy(
      ManagedPolicy.fromManagedPolicyName(
        this, 'KarpenterControllerPolicy', `KarpenterControllerPolicy-${cluster.clusterName}`))

    new cdk.CfnOutput(this, 'KarpenterServiceAccountRole', {
      value: karpenterServiceAccount.role.roleArn
    })

    //const chart = new cdk8s.Chart(new cdk8s.App(), 'Demo')


    cluster.addHelmChart('MetricsServer', {
      chart: 'metrics-server',
      release: 'metrics-server',
      repository: 'https://kubernetes-sigs.github.io/metrics-server/',
      wait: true,
      namespace: 'kube-system'
    })

    //cluster.addCdk8sChart('DemoChart', chart)

    // Set up Code Pipeline
    const pipeline = new Pipeline(this, 'BuildAndReleasePipeline')
    const sourceOutput = new Artifact()
    const x86BuildOutput = new Artifact()
    const imageRepo = new Repository(this, 'PetClinicRepo');

    // Source stage
    const sourceStage = pipeline.addStage({ stageName: 'Source' })

    const gitHubConnection = new connections.CfnConnection(this, 'GitHubConnection', {
      connectionName: 'GitHub',
      providerType: 'GitHub'
    })

    sourceStage.addAction(new CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      connectionArn: gitHubConnection.attrConnectionArn,
      owner: 'otterley',
      repo: 'spring-petclinic',
      branch: 'aws-under-the-hood',
      output: sourceOutput,
      triggerOnPush: true
    }))

    // Build stage
    const buildStage = pipeline.addStage({ stageName: 'Build' })
    const x86BuildProject = new codebuild.PipelineProject(this, 'x86BuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          IMAGE_REPO_URI: { value: imageRepo.repositoryUri },
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account }
        },
        privileged: true
      },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        env: {
          shell: 'bash'
        },
        phases: {
          pre_build: {
            commands: [
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
            ]
          },
          build: {
            commands: [
              'docker build -t ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}-x86 .'
            ]
          },
          post_build: {
            commands: [
              'docker push ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}-x86'
            ]
          }
        }
      })
    })
    imageRepo.grantPullPush(x86BuildProject)

    buildStage.addAction(new CodeBuildAction({
      actionName: 'x86',
      input: sourceOutput,
      outputs: [x86BuildOutput],
      project: x86BuildProject
    }))

    const gravitonBuildProject = new codebuild.PipelineProject(this, 'GravitonBuildProject', {
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_2_0,
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          IMAGE_REPO_URI: { value: imageRepo.repositoryUri },
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account }
        },
        privileged: true
      },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        env: {
          shell: 'bash'
        },
        phases: {
          pre_build: {
            commands: [
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
            ]
          },
          build: {
            commands: [
              'docker build -t ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}-arm64 .'
            ]
          },
          post_build: {
            commands: [
              'docker push ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}-arm64'
            ]
          }
        }
      })
    })
    imageRepo.grantPullPush(gravitonBuildProject)
    buildStage.addAction(new CodeBuildAction({
      actionName: 'arm64',
      input: sourceOutput,
      project: gravitonBuildProject
    }))

    // Manifest stage
    const manifestStage = pipeline.addStage({ stageName: 'Manifest' })

    const manifestBuildProject = new codebuild.PipelineProject(this, 'ManifestBuildProject', {
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_2_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          IMAGE_REPO_URI: { value: imageRepo.repositoryUri },
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account }
        },
      },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        env: {
          shell: 'bash'
        },
        phases: {
          pre_build: {
            commands: [
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
            ]
          },
          build: {
            'on-failure': 'ABORT',
            commands: [
              'IMAGE_BASE=${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}',
              'docker manifest create $IMAGE_BASE ${IMAGE_BASE}-arm64 ${IMAGE_BASE}-x86'
            ]
          },
          post_build: {
            commands: [
              'docker manifest push ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}'
            ]
          }
        }
      })
    })

    imageRepo.grantPullPush(manifestBuildProject)

    manifestStage.addAction(new CodeBuildAction({
      actionName: 'Create',
      input: sourceOutput,
      project: manifestBuildProject
    }))

    // Deploy stage
    const deployStage = pipeline.addStage({ stageName: 'Deploy' })
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_2_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          IMAGE_REPO_URI: { value: imageRepo.repositoryUri },
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account },
          CLUSTER_NAME: { value: cluster.clusterName },
          CLUSTER_ROLE_ARN: { value: cluster.adminRole.roleArn }
        },
      },
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        env: {
          shell: 'bash'
        },
        phases: {
          install: {
            commands: [
              'curl -o /tmp/kubectl https://s3.us-west-2.amazonaws.com/amazon-eks/1.24.10/2023-01-30/bin/linux/arm64/kubectl',
              'chmod +x /tmp/kubectl',
              'aws eks update-kubeconfig --name $CLUSTER_NAME --region $AWS_DEFAULT_REGION --role-arn $CLUSTER_ROLE_ARN'
            ]
          },
          pre_build: {
            commands: [
              'echo "- op: replace" >> deploy/image.patch.yaml',
              'echo "  path: /spec/template/spec/containers/0/image" >> deploy/image.patch.yaml',
              'echo "  value: ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}" >> deploy/image.patch.yaml'
            ]
          },
          build: {
            commands: [
              '/tmp/kubectl apply -k deploy'
            ]
          }
        }
      })
    })
    deployProject.role?.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['eks:DescribeCluster'],
      resources: [cluster.clusterArn]
    }))
    deployStage.addAction(new CodeBuildAction({
      actionName: 'ToCluster',
      input: sourceOutput,
      project: deployProject
    }))
  }
}
