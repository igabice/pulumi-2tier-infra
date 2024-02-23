import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsNative from "@pulumi/aws-native";

import { CIDR_BLOCK, AMI, ALL_IP, PORTS, INSTANCE_TYPE } from './variables';


const availabilityZones = ['us-east-1a', 'us-east-1b', 'us-east-1c'];

const tags = {
    Name: `infra-test`,
};

const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: CIDR_BLOCK[0],
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags,
});


// Create Internet Gateway
const internetGateway = new aws.ec2.InternetGateway("my-internet-gateway", {
    vpcId: vpc.id,
    tags: tags
});


// Create a new security group for the EC2 instances
const webSecurityGroup = new aws.ec2.SecurityGroup("web-sg", {
    vpcId: vpc.id,
    name: 'Web SG',
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ALL_IP
    }],
    ingress: [{
        fromPort: PORTS.WEB,
        toPort: PORTS.WEB,
        protocol: "tcp",
        cidrBlocks: ALL_IP,
    }],
    tags: tags
});

const sshSecurityGroup = new aws.ec2.SecurityGroup("ssh-sg", {
    vpcId: vpc.id,
    name: 'SSH SG',

    ingress: [
        {
            fromPort: PORTS.PING,
            toPort: PORTS.PING,
            protocol: "tcp",
            cidrBlocks: ALL_IP,

        }],
    tags: tags
});

const apiSecurityGroup = new aws.ec2.SecurityGroup("api-sg", {
    vpcId: vpc.id,
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ALL_IP
    }],
    ingress: [{
        fromPort: PORTS.API,
        toPort: PORTS.API,
        protocol: "tcp",
        securityGroups: [webSecurityGroup.id], // Allow traffic only from ec2SecurityGroup
    }],
    tags: tags
});



const routeTable = new aws.ec2.RouteTable('my-route-table', {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }]
});

// const routeTableAssn = new aws.ec2.RouteTableAssociation('my-route-table-assn', {
//     subnetId: subnet.id,
//     routeTableId: routeTable.id
// });

// Find the latest Amazon Linux 2 AMI in the chosen region
const ami = pulumi.output(aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["amzn2-ami-hvm-*-x86_64-gp2"] },
        { name: "state", values: ["available"] },
    ],
    owners: ["amazon"],
    mostRecent: true,
}));


// const webInstance = new aws.ec2.Instance("web-instance", {
//     instanceType: INSTANCE_TYPE,
//     ami: ami.id,
//     tags,
//     keyName: 'app-key',
//     userData: webScript,
//     vpcSecurityGroupIds: [webSecurityGroup.id, sshSecurityGroup.id],
//     subnetId: subnet.id,
//     associatePublicIpAddress: true,  // for ssh
// });



// Create a Network ACL
// const nacl = new aws.ec2.NetworkAcl("my-nacl", {
//     vpcId: vpc.id,
//     tags
// });

// // Allow all inbound and outbound traffic in the NACL
// const allowAllInbound = new aws.ec2.NetworkAclRule("allow-all-inbound", {
//     networkAclId: nacl.id,
//     ruleNumber: 100,
//     protocol: "-1", // Allow all protocols
//     ruleAction: "allow",
//     egress: false, // Inbound traffic
//     cidrBlock: "0.0.0.0/0", // Allow from all sources
// });

// const allowAllOutbound = new aws.ec2.NetworkAclRule("allow-all-outbound", {
//     networkAclId: nacl.id,
//     ruleNumber: 100,
//     protocol: "-1", // Allow all protocols
//     ruleAction: "allow",
//     egress: true, // Outbound traffic
//     cidrBlock: "0.0.0.0/0", // Allow to all destinations
// });

const privateSubnets: aws.ec2.Subnet[] = [];
const publicSubnets: aws.ec2.Subnet[] = [];


//this will be used to setup a multi-AZ deployment for high availability
for (let i = 0; i < availabilityZones.length; i++) {
    const privateSubnet = new aws.ec2.Subnet(`private-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i}.0/24`,
        availabilityZone: availabilityZones[i],
        mapPublicIpOnLaunch: false,
        tags: tags
    });

    const publicSubnet = new aws.ec2.Subnet(`public-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 100}.0/24`,
        availabilityZone: availabilityZones[i],
        mapPublicIpOnLaunch: true,
        tags: tags
    });

    privateSubnets.push(privateSubnet);
    publicSubnets.push(publicSubnet);
}

const publicSubnetsIds = publicSubnets.map(subnet => subnet.id);
// const privateSubnetsIds = privateSubnets.map(subnet => subnet.id);


// Create an ALB
const alb = new aws.lb.LoadBalancer("my-alb", {
    internal: false,
    securityGroups: [webSecurityGroup.id],
    subnets: publicSubnetsIds,
    loadBalancerType: "application",
});

// Create a target group
const targetGroup = new aws.lb.TargetGroup("my-target-group", {
    port: 3000,
    protocol: "HTTP",
    vpcId: vpc.id,
    targetType: "instance",
});

// Attach the target group to the ALB
const listener = new aws.lb.Listener("my-listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
});


const apiScript = pulumi.interpolate`
            #!/bin/bash
            sudo yum update -y
            sudo yum install docker -y
            sudo yum install git -y
            sudo systemctl start docker
            sudo systemctl enable docker
            sudo usermod -a -G docker ec2-user

            # Clone Git repository
            git clone https://github.com/igabice/infra-api.git /infra-api

            # Build Docker image
            sudo docker build -t infra-app /infra-api/. | tail -n 2 | head -n 1 | cut -d" " -f3 > dockerId
            # Run Docker container
            sudo docker run -d -p 5000:5000 $(cat dockerId)
        `;

const apiInstance = new aws.ec2.Instance("api-instance", {
    instanceType: INSTANCE_TYPE,
    ami: ami.id,
    tags: { Name: 'api' },
    keyName: 'app-key',
    userData: apiScript,
    vpcSecurityGroupIds: [apiSecurityGroup.id, sshSecurityGroup.id],
    subnetId: publicSubnets[0].id,
});

const webScript = pulumi.interpolate`
            #!/bin/bash
            sudo yum update -y
            sudo yum install docker -y
            sudo yum install git -y
            sudo systemctl start docker
            sudo systemctl enable docker
            sudo usermod -a -G docker ec2-user

            # Clone Git repository
            git clone https://github.com/igabice/infra-web.git /infra-web
            
            # Build Docker image
            sudo docker build -t infra-app /infra-web/. | tail -n 2 | head -n 1 | cut -d" " -f3 > dockerId
            # Run Docker container
            sudo docker run -d -e ApiAddress="http://${apiInstance.privateIp}:5000/WeatherForecast" -p 3000:5000 $(cat dockerId)
        `;


const base64EncodedUserData = webScript.apply(s => Buffer.from(s).toString("base64"));

// const launchConfiguration = new awsNative.autoscaling.LaunchConfiguration('my-lc', {
//     imageId: AMI,
//     instanceType: INSTANCE_TYPE,
//     securityGroups: [webSecurityGroup.id],
//     userData: base64EncodedUserData,
//     keyName: 'app-key'
// });

const launchTemplate = new aws.ec2.LaunchTemplate('my-lt', {
    name: 'my-launchtemplate',
    imageId: ami.id,
    instanceType: INSTANCE_TYPE,
    keyName: 'app-key',
    vpcSecurityGroupIds: [webSecurityGroup.id, sshSecurityGroup.id],
    userData: base64EncodedUserData,
});


// Create an ASG
const asg = new awsNative.autoscaling.AutoScalingGroup("my-asg", {
    // launchConfigurationName: launchConfiguration.id,
    launchTemplate: {
        launchTemplateName: launchTemplate.name,
        version: '1',
    },
    minSize: '1',
    maxSize: '3',
    desiredCapacity: '2',
    availabilityZones: availabilityZones,
    vpcZoneIdentifier: publicSubnetsIds,
    targetGroupArns: [targetGroup.arn],
});

// const asgAttachment = new aws.lb.TargetGroupAttachment("my-asg-attachment", {
//     targetGroupArn: targetGroup.arn,
//     targetId: asg.arn,
// });
// launchConfigurationName: launchConfiguration.id,

// Export the DNS name of the ALB
export const albDNSName = alb.dnsName;

// Export the public IP of the EC2 instance
