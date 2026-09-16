-- Draft pool RLS policies
--
-- Adds row-level security policy for the draft_pools and
-- draft_pool_pokemon tables so league members can view pools while only the
-- league owner can create, update, or delete them:
--   - Any active league member may SELECT draft pools and pool Pokémon.
--   - Only the league owner may INSERT/UPDATE/DELETE pools and pool Pokémon.

-- Members of the owning league can view any draft pool in that league.
DROP POLICY IF EXISTS "Members can view draft pools" ON public.draft_pools;
CREATE POLICY "Members can view draft pools"
ON public.draft_pools
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.league_members lm
    WHERE lm.league_id = draft_pools.league_id
      AND lm.user_id = auth.uid()
      AND lm.is_active = TRUE
  )
);

-- Only the league owner can create, edit, or delete draft pools.
DROP POLICY IF EXISTS "League owners can manage draft pools" ON public.draft_pools;
CREATE POLICY "League owners can manage draft pools"
ON public.draft_pools
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = draft_pools.league_id AND l.owner_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leagues l
    WHERE l.id = draft_pools.league_id AND l.owner_id = auth.uid()
  )
);

-- Members of the owning league can view pool Pokémon in that league.
DROP POLICY IF EXISTS "Members can view pool Pokemon" ON public.draft_pool_pokemon;
CREATE POLICY "Members can view pool Pokemon"
ON public.draft_pool_pokemon
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.draft_pools dp
    JOIN public.league_members lm ON lm.league_id = dp.league_id
    WHERE dp.id = draft_pool_pokemon.draft_pool_id
      AND lm.user_id = auth.uid()
      AND lm.is_active = TRUE
  )
);

-- Only the owner of the pool's league can create, edit, or delete pool Pokémon.
DROP POLICY IF EXISTS "League owners can manage pool Pokemon" ON public.draft_pool_pokemon;
CREATE POLICY "League owners can manage pool Pokemon"
ON public.draft_pool_pokemon
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.draft_pools dp
    JOIN public.leagues l ON l.id = dp.league_id
    WHERE dp.id = draft_pool_pokemon.draft_pool_id
      AND l.owner_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.draft_pools dp
    JOIN public.leagues l ON l.id = dp.league_id
    WHERE dp.id = draft_pool_pokemon.draft_pool_id
      AND l.owner_id = auth.uid()
  )
);