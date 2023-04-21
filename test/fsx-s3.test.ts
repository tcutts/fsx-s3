import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as FsxS3 from '../lib/fsx-s3-stack';

test('Resources created', () => {
    const app = new cdk.App();
    const stack = new FsxS3.FsxS3Stack(app, 'MyTestStack');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::Instance', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::FSx::FileSystem', {
        "FileSystemType": "LUSTRE",
    });
    template.resourceCountIs('AWS::FSx::DataRepositoryAssociation', 1);
});
