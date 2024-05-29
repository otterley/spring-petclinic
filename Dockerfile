FROM public.ecr.aws/amazoncorretto/amazoncorretto:21
RUN mkdir /app
WORKDIR /app
COPY target/spring-petclinic-3.2.0-SNAPSHOT.jar /app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/spring-petclinic-3.2.0-SNAPSHOT.jar"]
