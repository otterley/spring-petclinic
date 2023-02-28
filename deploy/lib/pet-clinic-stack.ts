import * as cdk from 'aws-cdk-lib'
import { type Construct } from 'constructs'
import { InstanceType, Port, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import * as eks from 'aws-cdk-lib/aws-eks'
import * as kms from 'aws-cdk-lib/aws-kms'
import { AlbControllerVersion, Cluster, CoreDnsComputeType } from 'aws-cdk-lib/aws-eks'
import { KubectlV24Layer } from '@aws-cdk/lambda-layer-kubectl-v24'
import { CfnInstanceProfile, ManagedPolicy, Policy, PolicyDocument, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { Aspects, CfnOutput, Tag } from 'aws-cdk-lib'
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, MysqlEngineVersion } from 'aws-cdk-lib/aws-rds'
import { Key } from 'aws-cdk-lib/aws-kms'
import { Queue } from 'aws-cdk-lib/aws-sqs'

interface PetClinicStackProps extends cdk.StackProps {
  deployEnv: "test" | "prod"
}

export class PetClinicStack extends cdk.Stack {
  public deployEnv: string
  public cluster: Cluster
  public database: DatabaseInstance

  constructor(scope: Construct, id: string, props: PetClinicStackProps) {
    super(scope, id, props)
    this.deployEnv = props.deployEnv

    const vpc = new Vpc(this, `${this.deployEnv}Vpc`, {
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

    this.cluster = new eks.Cluster(this, `${this.deployEnv}Cluster`, {
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
      value: this.cluster.clusterName
    })

    this.cluster.addFargateProfile('Karpenter', {
      selectors: [{ namespace: 'karpenter' }]
    })
    this.cluster.addFargateProfile('System', {
      selectors: [{ namespace: 'kube-system' }]
    })

    const nodeRole = new Role(this, 'NodeRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy')
      ]
    })
    this.cluster.awsAuth.addRoleMapping(nodeRole, {
      username: 'system:node:{{EC2PrivateDNSName}}',
      groups: ['system:bootstrappers', 'system:nodes']
    })
    const nodeInstanceProfile = new CfnInstanceProfile(this, 'NodeInstanceProfile', { roles: [nodeRole.roleName] })
    new CfnOutput(this, 'KarpenterInstanceProfile', { value: nodeInstanceProfile.ref })


    const karpenterNamespace = this.cluster.addManifest('Karpenter', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'karpenter',
        labels: {
          name: 'karpenter'
        }
      }
    });
    const karpenterServiceAccount = this.cluster.addServiceAccount('Karpenter', {
      namespace: 'karpenter',
      name: 'karpenter'
    });
    karpenterServiceAccount.node.addDependency(karpenterNamespace);

    const karpenterQueue = new Queue(this, `${this.deployEnv}KarpenterNotifications`);
    new cdk.CfnOutput(this, 'KarpenterNotificationQueue', {
      value: karpenterQueue.queueName
    })

    const karpenterServiceAccountPolicy = new Policy(this, `${this.deployEnv}ServiceAccountPolicy`, {
      document: PolicyDocument.fromJson(JSON.parse(`
      {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Action": [
                    "ec2:CreateFleet",
                    "ec2:CreateLaunchTemplate",
                    "ec2:CreateTags",
                    "ec2:DeleteLaunchTemplate",
                    "ec2:RunInstances",
                    "ec2:TerminateInstances",
                    "ec2:DescribeAvailabilityZones",
                    "ec2:DescribeImages",
                    "ec2:DescribeInstances",
                    "ec2:DescribeInstanceTypeOfferings",
                    "ec2:DescribeInstanceTypes",
                    "ec2:DescribeLaunchTemplates",
                    "ec2:DescribeSecurityGroups",
                    "ec2:DescribeSpotPriceHistory",
                    "ec2:DescribeSubnets",
                    "pricing:GetProducts",
                    "ssm:GetParameter"
                ],
                "Resource": "*",
                "Effect": "Allow"
            },
            {
                "Action": [
                    "sqs:DeleteMessage",
                    "sqs:GetQueueAttributes",
                    "sqs:GetQueueUrl",
                    "sqs:ReceiveMessage"
                ],
                "Resource": "${karpenterQueue.queueArn}",
                "Effect": "Allow"
            },
            {
                "Action": [
                    "iam:PassRole"
                ],
                "Resource": "${nodeRole.roleArn}",
                "Effect": "Allow"
            },
            {
                "Action": [
                    "eks:DescribeCluster"
                ],
                "Resource": "${this.cluster.clusterArn}",
                "Effect": "Allow"
            }
        ]
    }
      `))
    })
    karpenterServiceAccount.role.attachInlinePolicy(karpenterServiceAccountPolicy);

    new cdk.CfnOutput(this, 'KarpenterServiceAccountRole', {
      value: karpenterServiceAccount.role.roleArn
    })

    this.cluster.addHelmChart('MetricsServer', {
      chart: 'metrics-server',
      release: 'metrics-server',
      repository: 'https://kubernetes-sigs.github.io/metrics-server/',
      wait: true,
      namespace: 'kube-system'
    })


    // Database
    const credentialsKey = new Key(this, 'RDSEncryptionKey')
    const credentials = Credentials.fromGeneratedSecret('admin', {
      encryptionKey: credentialsKey
    })

    this.database = new DatabaseInstance(this, `${this.deployEnv}Database`, {
      credentials,
      engine: DatabaseInstanceEngine.mysql({version: MysqlEngineVersion.VER_8_0}),
      instanceType: new InstanceType('t3.micro'),
      vpc: vpc,
      vpcSubnets: vpc.selectSubnets({subnetType: SubnetType.PRIVATE_WITH_EGRESS}),
    })
    this.database.connections.allowFrom(this.cluster.clusterSecurityGroup, Port.tcp(3306))
    new CfnOutput(this, 'DatabaseSecretName', { value: this.database.secret?.secretName || 'unknown' })
    new CfnOutput(this, 'DatabaseEndpoint', { value: `${this.database.dbInstanceEndpointAddress}:${this.database.dbInstanceEndpointPort}` })

    Aspects.of(this).add(new Tag('environment', this.deployEnv))
  }
}
