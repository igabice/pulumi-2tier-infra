import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsNative from "@pulumi/aws-native";

import { CIDR_BLOCK, ALL_IP, PORTS, INSTANCE_TYPE } from './variables';


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

// Internet Gateway to allow traffic to the internet
const internetGateway = new aws.ec2.InternetGateway("my-internet-gateway", {
    vpcId: vpc.id,
    tags: tags
});

// web security
const webSecurityGroup = new aws.ec2.SecurityGroup("web-sg", {
    vpcId: vpc.id,
    name: 'Web SG',
    // allows request out of instance
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ALL_IP
    }],
    // allows request from all to instance on only port 3000
    ingress: [{
        fromPort: PORTS.WEB,
        toPort: PORTS.WEB,
        protocol: "tcp",
        cidrBlocks: ALL_IP,
    }],
    tags: tags
});

// Create a new security group for the EC2 instances
const webAsgSecurityGroup = new aws.ec2.SecurityGroup("asg-sg", {
    vpcId: vpc.id,
    name: 'ASG SG',
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ALL_IP
    }],
    ingress: [{
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        cidrBlocks: ALL_IP,
    }],
    tags: tags
});

// to allow ssh connection for instance inspection etc using 22 ping port but best to change to a higher port number
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

// api security
const apiSecurityGroup = new aws.ec2.SecurityGroup("api-sg", {
    vpcId: vpc.id,
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ALL_IP
    }],
    // Limits connection to api from only web 
    ingress: [{
        fromPort: PORTS.API,
        toPort: PORTS.API,
        protocol: "tcp",
        securityGroups: [webSecurityGroup.id], 
    }],
    tags: tags
});

// defines range of aws resources ips can access the internet gateway
const routeTable = new aws.ec2.RouteTable('my-route-table', {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: internetGateway.id }]
});



// Find the latest Amazon Linux 2 AMI in the present region
const ami = pulumi.output(aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["amzn2-ami-hvm-*-x86_64-gp2"] },
        { name: "state", values: ["available"] },
    ],
    owners: ["amazon"],
    mostRecent: true,
}));

const publicSubnets: aws.ec2.Subnet[] = [];


//this will be used to setup a multi-AZ deployment for high availability
for (let i = 0; i < availabilityZones.length; i++) {

    const publicSubnet = new aws.ec2.Subnet(`public-subnet-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 100}.0/24`,
        availabilityZone: availabilityZones[i],
        mapPublicIpOnLaunch: true,
        tags: tags
    });

    //links subnets to route table which enables internet connectivity
    const routeTableAssn = new aws.ec2.RouteTableAssociation(`my-route-table-assn${i}`, {
        subnetId: publicSubnet.id,
        routeTableId: routeTable.id
    });
    publicSubnets.push(publicSubnet);
}

const publicSubnetsIds = publicSubnets.map(subnet => subnet.id);

// Load balancer for web: the shares request among web instances
const alb = new aws.lb.LoadBalancer("my-alb", {
    internal: false,
    securityGroups: [webAsgSecurityGroup.id, webSecurityGroup.id],
    subnets: publicSubnetsIds,
    loadBalancerType: "application",
});

//target group that receives requests from a load balancer
const targetGroup = new aws.lb.TargetGroup("my-target-group", {
    port: 3000,
    protocol: "HTTP",
    vpcId: vpc.id,
    targetType: "instance",
});



// Attach the target group to the ALB via a listener
const listener = new aws.lb.Listener("my-listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
});

/*
#can use nat gateway for higher security but this will require using Elastic IP which isn't available on free tier.

#Do uncomment this block and update the subnetId of apiInstance with privateSubnet.id

const eip = new aws.ec2.Eip("nat-eip");
const natGateway = new aws.ec2.NatGateway("nat-gateway", {
    subnetId: publicSubnetsIds[0],
    allocationId: eip.id
});

const privateSubnet = new aws.ec2.Subnet(`public-subnet-${i}`, {
    vpcId: vpc.id,
    cidrBlock: `10.0.105.0/24`,
    availabilityZone: availabilityZones[0],
    mapPublicIpOnLaunch: false,
    tags: tags
});
//route table for the private subnet
const privateRouteTable = new aws.ec2.RouteTable("private-route-table", {
    vpcId: vpc.id,
});

//private subnet to route traffic through the NAT Gateway
const privateRoute = new aws.ec2.Route("private-route", {
    routeTableId: privateRouteTable.id,
    destinationCidrBlock: "0.0.0.0/0",
    natGatewayId: natGateway.id,
});

const privateSubnetAssociation = new aws.ec2.RouteTableAssociation("private-subnet-association", {
    subnetId: publicSubnetsIds[0],
    routeTableId: privateRouteTable.id,
});

*/


//user data script that sets up the api Instance is initialised while the EC2 instance boots for the first time
// it pulls the source code from a git repo and builds the docker image before running
// Amazon Linux has issues running a container with the image tag so i saved the image unique id to a file which i used to start the image
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
    tags,
    keyName: 'app-key',
    userData: apiScript,
    vpcSecurityGroupIds: [apiSecurityGroup.id, sshSecurityGroup.id],
    subnetId: publicSubnetsIds[0],
});

// user data script for web.
// the ip of the api instance is passed as an environment variable to the docker run command to allow communication to the api instance
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

//launch template requires user data script to be base64 encoded
const base64EncodedUserData = webScript.apply(s => Buffer.from(s).toString("base64"));

// const launchConfiguration = new awsNative.autoscaling.LaunchConfiguration('my-lc', {
//     imageId: AMI,
//     instanceType: INSTANCE_TYPE,
//     securityGroups: [webSecurityGroup.id],
//     userData: base64EncodedUserData,
//     keyName: 'app-key'
// });

//this is the template for creating new EC2 instance by the autoscaling group
const launchTemplate = new aws.ec2.LaunchTemplate('my-lt', {
    name: 'my-launchtemplate',
    imageId: ami.id,
    instanceType: INSTANCE_TYPE,
    keyName: 'app-key',
    vpcSecurityGroupIds: [webSecurityGroup.id, sshSecurityGroup.id],
    userData: base64EncodedUserData,
});


// This ensures a desired number of web instances is running at any given time. 
// It adds new instances of total health of instance exeeds 40%
// would have also set cloud watch alarms and scale out/in policies due to cpu utilization or request count threshold
const asg = new awsNative.autoscaling.AutoScalingGroup("my-asg", {
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

export const albDNSName = alb.dnsName;

// Export the public IP of the EC2 instance
