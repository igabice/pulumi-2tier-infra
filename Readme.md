## Infra set up with Pulumi & Typescript

The project is a project written with pulumi `aws-typescript` to set up infrastructure required for a web and api connection.

The api instance is protected by a security group that allows only connection from the web instances.

The web and api source code are pull from github repositories during initialization of the ec2 instance and made to run as docker containers inside the instance. 

```
web https://github.com/igabice/infra-web.git
api https://github.com/igabice/infra-api.git 
```

the index.ts file includes comments that better explains each resource.
## To initialize IAC

```
npm install

```

## To deploy IAC
```
pulumi up
```


## To destroy IAC
```
pulumi down
```