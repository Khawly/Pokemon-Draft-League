-- Remove the notification Pokemon lookup and name the team in free-agency notices.
--
-- The dashboard no longer draws sprites inside notification entries, so
-- notification_pokemon has no caller. Dropping it closes an unused
-- security-definer read path rather than leaving it exposed to the browser.
--
-- Free-agency notices used to say a Pokemon was added to or dropped from a
-- player. The move is to or from that player's team, so the message now names
-- the team: the owner's name in the possessive, or the team name when no profile
-- name is available.

DROP FUNCTION IF EXISTS public.notification_pokemon(UUID[]);

-- Announces a free agent pickup or a release to the league, naming the team the
-- Pokemon joined or left.
CREATE OR REPLACE FUNCTION public.notify_free_agency_move()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_species TEXT;
  v_owner_name TEXT;
  v_team_name TEXT;
  v_team_label TEXT;
  v_message TEXT;
BEGIN
  SELECT r.species_name INTO v_species
  FROM public.team_roster r
  WHERE r.team_id = NEW.team_id
    AND r.pokemon_id = NEW.pokemon_id
  LIMIT 1;

  IF v_species IS NULL THEN
    SELECT dpp.species_name INTO v_species
    FROM public.draft_pool_pokemon dpp
    JOIN public.draft_pools dp ON dp.id = dpp.draft_pool_id
    WHERE dp.league_id = NEW.league_id
      AND dp.season_id = NEW.season_id
      AND dpp.pokemon_id = NEW.pokemon_id
    ORDER BY dp.is_active DESC, dpp.updated_at DESC
    LIMIT 1;
  END IF;

  v_species := COALESCE(v_species, initcap(replace(NEW.pokemon_id, '-', ' ')));

  SELECT
    NULLIF(BTRIM(p.display_name), ''),
    NULLIF(BTRIM(t.team_name), '')
  INTO v_owner_name, v_team_name
  FROM public.teams t
  LEFT JOIN public.profiles p ON p.id = t.owner_user_id
  WHERE t.id = NEW.team_id;

  v_team_label := CASE
    WHEN v_owner_name IS NOT NULL THEN v_owner_name || '''s team'
    WHEN v_team_name IS NOT NULL THEN v_team_name
    ELSE 'a team'
  END;

  IF NEW.action = 'added' THEN
    v_message := format(
      '%s was added to %s from free agency.',
      v_species,
      v_team_label
    );
  ELSE
    v_message := format(
      '%s was dropped from %s to free agency.',
      v_species,
      v_team_label
    );
  END IF;

  PERFORM public.notify_league_members(
    NEW.league_id,
    NEW.season_id,
    NEW.user_id,
    CASE
      WHEN NEW.action = 'added' THEN 'free_agent_added'
      ELSE 'free_agent_dropped'
    END,
    v_message,
    'transaction',
    NEW.id
  );

  RETURN NEW;
END;
$$;

-- The trigger already exists; only the function body changed. Re-created here so
-- a fresh database that runs this migration after 20261190 still has one.
DROP TRIGGER IF EXISTS transactions_notify_free_agency ON public.transactions;
CREATE TRIGGER transactions_notify_free_agency
AFTER INSERT ON public.transactions
FOR EACH ROW
WHEN (
  NEW.source IN ('free_agent_pickup', 'release')
  AND NEW.action IN ('added', 'dropped')
)
EXECUTE FUNCTION public.notify_free_agency_move();

-- Force PostgREST to pick up the dropped function and replaced trigger body.
NOTIFY pgrst, 'reload schema';
