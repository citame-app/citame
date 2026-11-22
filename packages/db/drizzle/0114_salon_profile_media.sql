CREATE TABLE salon_profile_media (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('logo', 'cover', 'gallery')),
  version uuid NOT NULL,
  alt text NOT NULL CHECK (length(btrim(alt)) BETWEEN 1 AND 160),
  image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 262144),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 1024),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX salon_profile_media_single_role ON salon_profile_media (kind) WHERE kind IN ('logo', 'cover');
