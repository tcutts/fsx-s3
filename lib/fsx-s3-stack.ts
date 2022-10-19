import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as fsx from "aws-cdk-lib/aws-fsx";
import * as iam from "aws-cdk-lib/aws-iam";

interface FsxS3StackProps extends StackProps {
  ubuntu?: boolean,
}
export class FsxS3Stack extends Stack {
  constructor(scope: Construct, id: string, props?: FsxS3StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "VPC", {
      maxAzs: 1,
    });

    const bucket = new s3.Bucket(this, "BackingBucket", {
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Do not use the following two lines in production
      // better to import an existing bucket so that CloudFormation
      // cannot accidentally destroy it
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
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
        deploymentType: fsx.LustreDeploymentType.SCRATCH_2,
        exportPath: bucket.s3UrlForObject(),
        importPath: bucket.s3UrlForObject(),
        autoImportPolicy: fsx.LustreAutoImportPolicy.NEW_CHANGED_DELETED,
        dataCompressionType: fsx.LustreDataCompressionType.LZ4,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const machineImage = props?.ubuntu ?
      ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/focal/stable/current/amd64/hvm/ebs-gp2/ami-id',
        { os: ec2.OperatingSystemType.LINUX}
      ) : new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      });

    const inst = new ec2.Instance(this, "inst", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.LARGE
      ),
      machineImage, 
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      userDataCausesReplacement: true,
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
    var user = 'ec2-user';
    var group = 'ec2-user';

    inst.userData.addCommands("set -eux");
    if (props?.ubuntu) {
      user = "ubuntu";
      group = "ubuntu";
      inst.userData.addCommands(
        "apt -y update && apt -y upgrade",
        "wget -O - https://fsx-lustre-client-repo-public-keys.s3.amazonaws.com/fsx-ubuntu-public-key.asc | gpg --dearmor | sudo tee /usr/share/keyrings/fsx-ubuntu-public-key.gpg >/dev/null",
        "echo 'deb [signed-by=/usr/share/keyrings/fsx-ubuntu-public-key.gpg] https://fsx-lustre-client-repo.s3.amazonaws.com/ubuntu jammy main' > /etc/apt/sources.list.d/fsxlustreclientrepo.list && apt-get -y update",
        "apt install -y linux-aws lustre-client-modules-aws",  
      );
    } else {
      inst.userData.addCommands(
        "yum update -y",
        "amazon-linux-extras install -y lustre",
      );
    }
    inst.userData.addCommands(
      `mkdir -p ${mountPath}`,
      `chmod 770 ${mountPath}`,
      `chown ${user}:${group} ${mountPath}`,
      `echo "${dnsName}@tcp:/${mountName} ${mountPath} lustre defaults,noatime,flock,_netdev 0 0" >> /etc/fstab`,
      "mount -a"
    );

    new CfnOutput(this, "InstanceID", {
      value: inst.instanceId,
    })
  }
}
