import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

interface InstanceStackArgs {
    autoTags: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

export class InstanceStack {
    instance: aws.ec2.Instance;
    instanceSecurityGroup: aws.ec2.SecurityGroup;

    constructor(name: string, args: InstanceStackArgs, opts?: pulumi.ComponentResourceOptions) {

        // Define your EC2 instance
        this.instanceSecurityGroup = new aws.ec2.SecurityGroup(name + "-sg", {
            // Define your security group rules
            tags: args.autoTags, // Apply auto-tags
        }, { parent: this });

        this.instance = new aws.ec2.Instance(name + "-instance", {
            // Define your EC2 instance configuration
            securityGroups: [this.instanceSecurityGroup.name],
            tags: args.autoTags, // Apply auto-tags
        }, { parent: this });

        // Export any relevant values
    }
}