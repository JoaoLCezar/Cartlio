-- Gallery editors cannot update gallery_shares directly; the status trigger
-- needs its owner's privileges to revoke links atomically with unpublishing.
alter function private.revoke_shares_on_unpublish() security definer;
