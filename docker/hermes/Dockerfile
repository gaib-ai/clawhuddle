# Hermes Agent (Nous Research) as a ClawHuddle instance runtime.
# Pinned: upstream ships several releases a week; an instance changes version
# only when this tag is bumped and the instance is redeployed.
FROM nousresearch/hermes-agent:v0.23.5
# ClawHuddle's helper: usage aggregates, pairing list and the Google sign-in
# steps, run by the API with `docker exec` as the `hermes` user.
COPY --chmod=0755 helper.py /opt/clawhuddle/helper.py
