import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as fsx from "aws-cdk-lib/aws-fsx";
import * as iam from "aws-cdk-lib/aws-iam";
interface FsxS3StackProps extends StackProps {
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
        deploymentType: fsx.LustreDeploymentType.PERSISTENT_2,
        perUnitStorageThroughput: 1000,
        dataCompressionType: fsx.LustreDataCompressionType.LZ4,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Create a DRA between the filesystem and the bucket
    const dra = new fsx.CfnDataRepositoryAssociation(this, 'DRA', {
      dataRepositoryPath: `s3://${bucket.bucketName}/`,
      fileSystemId: lustrefs.fileSystemId,
      fileSystemPath: '/',
      s3: {
        autoImportPolicy: {
          events: ['NEW', 'CHANGED', 'DELETED'],
        },
        autoExportPolicy: {
          events: ['NEW', 'CHANGED', 'DELETED'],
        }
      }
    })

    const machineImage = new ec2.AmazonLinuxImage({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
    });

    const inst = new ec2.Instance(this, "inst", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.C6I,
        ec2.InstanceSize.XLARGE8
      ),
      machineImage,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      userDataCausesReplacement: true,
      init: this.createCloudInit(),
    });

    // Security Group needs to allow connections from instance to lustre
    lustrefs.connections.allowDefaultPortFrom(inst);

    // Instance needs access to FSx APIs
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

    inst.userData.addCommands(
      "set -eux",
      "yum update -y",
      "amazon-linux-extras install -y lustre",
      `mkdir -p ${mountPath}`,
      `chmod 770 ${mountPath}`,
      `chown ${user}:${group} ${mountPath}`,
      `echo "${dnsName}@tcp:/${mountName} ${mountPath} lustre defaults,noatime,flock,_netdev 0 0" >> /etc/fstab`,
      "# mount -a",
      // Best practice settings for large HPC instances
      "echo \"options ptlrpc ptlrpcd_per_cpt_max=32\" >> /etc/modprobe.d/modprobe.conf",
      "echo \"options ksocklnd credits=2560\" >> /etc/modprobe.d/modprobe.conf",
      "reboot"
    );

    new CfnOutput(this, "InstanceID", {
      value: inst.instanceId,
    })

    new CfnOutput(this, 'FS mountname', {
      value: mountName,
    })
  }

  // best practices lustre settings for large HPC instances
  private createCloudInit(): ec2.CloudFormationInit {
    const localScripts: ec2.InitElement[] = [];

    localScripts.push(
      ec2.InitFile.fromExistingAsset(
        "/etc/cron.d/lctl_boot",
        new Asset(this, "lctl_boot", {
          path: `assets/lctl_boot`,
        }),
        { mode: "000644" }
      )
    );

    localScripts.push(
      ec2.InitFile.fromExistingAsset(
        "/usr/local/bin/lctl_settings.sh",
        new Asset(this, "lctl_settings.sh", {
          path: "assets/lctl_settings.sh",
        }),
        { mode: "000700" },
      )
    );

    const init = ec2.CloudFormationInit.fromElements(
      ...localScripts,
    );

    return init;
  }
}
