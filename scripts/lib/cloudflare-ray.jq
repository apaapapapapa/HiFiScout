# Response headers can include a colo suffix (e.g. -IAD) while Worker tail headers omit it.
# Compare the complete hexadecimal ID, never a prefix, and reject malformed/missing IDs.
def cf_ray_id:
  if type != "string" then null
  elif test("^[0-9A-Fa-f]+(-[A-Za-z]{3})?$")
    then ascii_downcase | split("-")[0]
  else null
  end;

def same_cf_ray($expected):
  cf_ray_id as $actual
  | ($expected | cf_ray_id) as $ray
  | ($ray != null and $actual == $ray);
