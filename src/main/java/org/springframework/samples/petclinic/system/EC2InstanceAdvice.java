package org.springframework.samples.petclinic.system;

import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ModelAttribute;

@ControllerAdvice
public class EC2InstanceAdvice {

	@ModelAttribute("osArch")
	public String getOsArch() {
		return System.getProperty("os.arch");
	}

	@ModelAttribute("isGravitonInstance")
	private boolean isGravitonInstance() {
		return System.getProperty("os.arch").equals("aarch64");
	}

}
