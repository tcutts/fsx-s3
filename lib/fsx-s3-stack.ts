import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as fsx from "aws-cdk-lib/aws-fsx";
import * as iam from "aws-cdk-lib/aws-iam";
import { CdkCommand } from "aws-cdk-lib/cloud-assembly-schema";

export class FsxS3Stack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "VPC", {
      maxAzs: 1,
    });

    const bucket = new s3.Bucket(this, "BackingBucket", {
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
    });

    const lustrefs = new fsx.LustreFileSystem(this, "Lustre", {
      vpc: vpc,
      vpcSubnet: vpc.privateSubnets[0],
      storageCapacityGiB: 1200,
      lustreConfiguration: {
        deploymentType: fsx.LustreDeploymentType.PERSISTENT_1,
        exportPath: bucket.s3UrlForObject(),
        importPath: bucket.s3UrlForObject(),
        autoImportPolicy: fsx.LustreAutoImportPolicy.NEW_CHANGED_DELETED,
        perUnitStorageThroughput: 50,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const inst = new ec2.Instance(this, "inst", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.LARGE
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
      },
    });
    lustrefs.connections.allowDefaultPortFrom(inst);

    inst.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonFSxFullAccess")
    );

    // Allow console connection through Systems Manager.  Look, Ma, no
    // bastion host needed, but still on a private subnet...
    inst.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    const mountPath = "/mnt/fsx";
    const dnsName = lustrefs.dnsName;
    const mountName = lustrefs.mountName;

    inst.userData.addCommands(
      "set -eux",
      "yum update -y",
      "amazon-linux-extras install -y lustre2.10",
      `mkdir -p ${mountPath}`,
      `chmod 777 ${mountPath}`,
      `chown ec2-user:ec2-user ${mountPath}`,
      `echo "${dnsName}@tcp:/${mountName} ${mountPath} lustre defaults,noatime,flock,_netdev 0 0" >> /etc/fstab`,
      "mount -a"
    );
  }
}
