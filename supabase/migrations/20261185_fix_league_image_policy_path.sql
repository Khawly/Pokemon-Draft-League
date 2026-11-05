-- Fix league image storage policies to read the object path, not the league name
--
-- The policies from 20261184 wrote storage.foldername(name) inside a subquery
-- over public.leagues l. Because l also has a name column, the unqualified name
-- resolved to l.name, so the policy compared the league id against the league's
-- display name. Every owner upload was therefore rejected by RLS. Qualifying the
-- storage object's column as objects.name makes the path check unambiguous.

DROP POLICY IF EXISTS "League owners can upload league images" ON storage.objects;
CREATE POLICY "League owners can upload league images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(objects.name))[1]
      AND l.owner_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "League owners can update league images" ON storage.objects;
CREATE POLICY "League owners can update league images"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(objects.name))[1]
      AND l.owner_id = auth.uid()
  )
)
WITH CHECK (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(objects.name))[1]
      AND l.owner_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "League owners can delete league images" ON storage.objects;
CREATE POLICY "League owners can delete league images"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'league-images'
  AND EXISTS (
    SELECT 1
    FROM public.leagues l
    WHERE l.id::TEXT = (storage.foldername(objects.name))[1]
      AND l.owner_id = auth.uid()
  )
);
