package org.springframework.samples.petclinic.system;

import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ModelAttribute;

import software.amazon.awssdk.imds.Ec2MetadataClient;
import software.amazon.awssdk.imds.Ec2MetadataResponse;

@ControllerAdvice
public class EC2InstanceAdvice {

	private static Ec2MetadataClient ec2MetadataClient = Ec2MetadataClient.create();

	private static String instanceType;

	@ModelAttribute("ec2InstanceType")
	public String getEC2InstanceType() {
		if (instanceType == null) {
			Ec2MetadataResponse ec2MetadataResponse = ec2MetadataClient.get("/latest/meta-data/instance-type");
			instanceType = ec2MetadataResponse.asString();
		}
		return instanceType;
	}

	@ModelAttribute("isGravitonInstance")
	private boolean isGravitonInstance() {
		return System.getProperty("os.arch").equals("aarch64");
	}

}