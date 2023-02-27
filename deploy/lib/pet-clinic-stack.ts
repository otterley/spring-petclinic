import * as cdk from 'aws-cdk-lib'
import { type Construct } from 'constructs'
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import * as eks from 'aws-cdk-lib/aws-eks'
import * as kms from 'aws-cdk-lib/aws-kms'
import { AlbControllerVersion, CoreDnsComputeType } from 'aws-cdk-lib/aws-eks'
import { KubectlV24Layer } from '@aws-cdk/lambda-layer-kubectl-v24'
//import * as cdk8s from 'cdk8s'
import { Pipeline, Artifact } from 'aws-cdk-lib/aws-codepipeline'
import { CodeStarConnectionsSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions'
import * as connections from 'aws-cdk-lib/aws-codestarconnections'

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
      }
    })

    cluster.addFargateProfile('Karpenter', {
      selectors: [{ namespace: 'karpenter' }]
    })
    cluster.addFargateProfile('System', {
      selectors: [{ namespace: 'kube-system' }]
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
    const gitHubConnection = new connections.CfnConnection(this, 'GitHubConnection', {
      connectionName: 'GitHub',
      providerType: 'GitHub'
    })

    const pipeline = new Pipeline(this, 'BuildAndReleasePipeline')

    const sourceOutput = new Artifact()
    const sourceStage = pipeline.addStage({ stageName: 'Source' })
    sourceStage.addAction(new CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      connectionArn: gitHubConnection.attrConnectionArn,
      owner: 'otterley',
      repo: 'spring-petclinic',
      branch: 'aws-under-the-hood',
      output: sourceOutput
    })
  }
}
