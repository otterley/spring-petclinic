package org.springframework.samples.petclinic.system;

import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ModelAttribute;

@ControllerAdvice
public class EC2InstanceAdvice {

	@ModelAttribute("ec2InstanceType")
	public String getEC2InstanceType() {
		String instanceType = System.getenv("EC2_INSTANCE_TYPE");
		return instanceType == null ? "Unknown (<tt>EC2_INSTANCE_TYPE</tt> not set)" : instanceType;
	}

	@ModelAttribute("isGravitonInstance")
	private boolean isGravitonInstance() {
		return System.getProperty("os.arch").equals("aarch64");
	}

}