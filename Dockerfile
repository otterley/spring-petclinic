FROM public.ecr.aws/docker/library/maven:3.9.0-amazoncorretto-17 AS build

ENV MAVEN_CONFIG=""

WORKDIR /workspace/app
COPY mvnw .
COPY .mvn .mvn
COPY pom.xml .
COPY src src

RUN ./mvnw package -DskipTests

FROM public.ecr.aws/amazoncorretto/amazoncorretto:17
COPY --from=build /workspace/app/target/*.jar /app.jar
ENTRYPOINT [ "java", "-jar", "/app.jar" ]
