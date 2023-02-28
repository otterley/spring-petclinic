import * as cdk from 'aws-cdk-lib'
import { type Construct } from 'constructs'
import { Cluster } from 'aws-cdk-lib/aws-eks'
import { Pipeline, Artifact } from 'aws-cdk-lib/aws-codepipeline'
import { CodeStarConnectionsSourceAction, CodeBuildAction, ManualApprovalAction } from 'aws-cdk-lib/aws-codepipeline-actions'
import * as connections from 'aws-cdk-lib/aws-codestarconnections'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import { Repository } from 'aws-cdk-lib/aws-ecr'
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild'
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { DatabaseInstance } from 'aws-cdk-lib/aws-rds'

interface PipelineStackProps extends cdk.StackProps {
  testCluster: Cluster
  testDatabase: DatabaseInstance

  prodCluster: Cluster
  prodDatabase: DatabaseInstance
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props)

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
      branch: 'aws-under-the-hood-multi-stage',
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

    // Test deploy stage
    const testDeployStage = pipeline.addStage({ stageName: 'TestDeploy' })
    const testDeployProject = new codebuild.PipelineProject(this, 'TestDeployProject', {
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_2_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          IMAGE_REPO_URI: { value: imageRepo.repositoryUri },
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account },
          CLUSTER_NAME: { value: props.testCluster.clusterName },
          CLUSTER_ROLE_ARN: { value: props.testCluster.kubectlRole?.roleArn },
          MYSQL_URL: { value: `jdbc:mysql://${props.testDatabase.dbInstanceEndpointAddress}/petclinic` }
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
              'export PATH=/usr/local/bin:$PATH',
              'curl https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip',
              '(cd /tmp && unzip -q awscliv2.zip && ./aws/install)',
              'curl -o /tmp/kubectl https://s3.us-west-2.amazonaws.com/amazon-eks/1.24.10/2023-01-30/bin/linux/arm64/kubectl',
              'chmod +x /tmp/kubectl',
              'aws eks update-kubeconfig --name $CLUSTER_NAME --region $AWS_DEFAULT_REGION --role-arn $CLUSTER_ROLE_ARN'
            ]
          },
          pre_build: {
            commands: [
              'echo "- op: replace" >> deploy/image.patch.yaml',
              'echo "  path: /spec/template/spec/containers/0/image" >> deploy/image.patch.yaml',
              'echo "  value: ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}" >> deploy/image.patch.yaml',
              'echo "- op: replace" >> deploy/image.patch.yaml',
              'echo "  path: /spec/template/spec/containers/0/env/0/value" >> deploy/image.patch.yaml',
              'echo "  value: ${MYSQL_URL}" >> deploy/image.patch.yaml'
            ]
          },
          build: {
            commands: [
              '/tmp/kubectl apply -k deploy'
            ]
          },
          post_build: {
            commands: [
              '/tmp/kubectl rollout status deployment/spring-petclinic --timeout=5m'
            ]
          }
        }
      })
    })
    testDeployProject.role?.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['eks:DescribeCluster'],
      resources: [props.testCluster.clusterArn]
    }))
    if (props.testCluster.kubectlRole) {
      testDeployProject.role?.addToPrincipalPolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [props.testCluster.kubectlRole.roleArn]
      }))
    }
    testDeployStage.addAction(new CodeBuildAction({
      actionName: 'ToCluster',
      input: sourceOutput,
      project: testDeployProject
    }))

    // Approval stage
    const approvalStage = pipeline.addStage({ stageName: 'Approval'})
    approvalStage.addAction(new ManualApprovalAction({actionName: 'ReleaseToProduction' }))


    // Prod deploy stage
    const prodDeployStage = pipeline.addStage({ stageName: 'ProdDeploy' })
    const prodDeployProject = new codebuild.PipelineProject(this, 'ProdDeployProject', {
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_2_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          IMAGE_REPO_URI: { value: imageRepo.repositoryUri },
          AWS_DEFAULT_REGION: { value: this.region },
          AWS_ACCOUNT_ID: { value: this.account },
          CLUSTER_NAME: { value: props.prodCluster.clusterName },
          CLUSTER_ROLE_ARN: { value: props.prodCluster.kubectlRole?.roleArn },
          MYSQL_URL: { value: `jdbc:mysql://${props.prodDatabase.dbInstanceEndpointAddress}/petclinic` }
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
              'export PATH=/usr/local/bin:$PATH',
              'curl https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o /tmp/awscliv2.zip',
              '(cd /tmp && unzip -q awscliv2.zip && ./aws/install)',
              'curl -o /tmp/kubectl https://s3.us-west-2.amazonaws.com/amazon-eks/1.24.10/2023-01-30/bin/linux/arm64/kubectl',
              'chmod +x /tmp/kubectl',
              'aws eks update-kubeconfig --name $CLUSTER_NAME --region $AWS_DEFAULT_REGION --role-arn $CLUSTER_ROLE_ARN'
            ]
          },
          pre_build: {
            commands: [
              'echo "- op: replace" >> deploy/image.patch.yaml',
              'echo "  path: /spec/template/spec/containers/0/image" >> deploy/image.patch.yaml',
              'echo "  value: ${IMAGE_REPO_URI}:${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}" >> deploy/image.patch.yaml',
              'echo "- op: replace" >> deploy/image.patch.yaml',
              'echo "  path: /spec/template/spec/containers/0/env/0/value" >> deploy/image.patch.yaml',
              'echo "  value: ${MYSQL_URL}" >> deploy/image.patch.yaml'
            ]
          },
          build: {
            commands: [
              '/tmp/kubectl apply -k deploy'
            ]
          },
          post_build: {
            commands: [
              '/tmp/kubectl rollout status deployment/spring-petclinic --timeout=5m'
            ]
          }
        }
      })
    })
    prodDeployProject.role?.addToPrincipalPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['eks:DescribeCluster'],
      resources: [props.prodCluster.clusterArn]
    }))
    if (props.prodCluster.kubectlRole) {
      prodDeployProject.role?.addToPrincipalPolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [props.prodCluster.kubectlRole.roleArn]
      }))
    }
    prodDeployStage.addAction(new CodeBuildAction({
      actionName: 'ToCluster',
      input: sourceOutput,
      project: prodDeployProject
    }))

  }
}
