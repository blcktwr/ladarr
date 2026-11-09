build:
	rm -f ladarr.oci.tar
	docker buildx build --platform linux/amd64 -o type=oci,dest=ladarr.oci.tar .

upload:
	scp ladarr.oci.tar root@192.168.1.99:/var/lib/vz/template/cache/
