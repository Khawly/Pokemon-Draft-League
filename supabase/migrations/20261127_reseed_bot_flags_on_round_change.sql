-- Extending a draft mid-flight re-seeds the bots' auto-pick flags.
--
-- Symptom: on a long draft the owner raised total_rounds (say 6 to 8) partway
-- through. Round 7 then took roughly 10 hours per bot instead of seconds, and
-- every bot finished the draft with a hole in its roster.
--
-- Cause: draft_round_settings rows are seeded by ensure_testbot_autopick_flags
-- for generate_series(1, COALESCE(ls.total_rounds, 7)), but that only runs from
-- the seasons status trigger, and only on the flip into draft_active
-- (20261007:132-149). Nothing re-runs it when total_rounds changes, so the new
-- rounds have no rows at all. With no row, the resolver falls back to the league
-- setting auto_pick_on_timeout, which defaults to FALSE (20250911:71), so
-- v_auto_pick stays false. advance_bot_autopicks then exits at the first bot of
-- the new round (20261008:79-92), the bot sits out its full limit, and
-- resolve_draft_timeout records a pass when the timer finally expires.
--
-- Fix: re-seed on the settings change. The seeding is ON CONFLICT DO NOTHING, so
-- this only adds the rounds that were just created. A flag an owner deliberately
-- turned off is left alone rather than being flipped back on, which matters
-- because the conflict clause is what makes this safe to fire on every update.
--
-- Calling it while the season is not drafting is harmless: it is idempotent and
-- simply tops the rows up to the current total_rounds before the draft starts.

-- Re-seeds bot auto-pick flags when a season's draft length changes, so rounds
-- added mid-draft get the same flags the original seeding gave them.
CREATE OR REPLACE FUNCTION public.on_league_settings_round_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.total_rounds IS DISTINCT FROM OLD.total_rounds THEN
    PERFORM public.ensure_testbot_autopick_flags(NEW.season_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS league_settings_reseed_bot_flags ON public.league_settings;
CREATE TRIGGER league_settings_reseed_bot_flags
AFTER UPDATE OF total_rounds ON public.league_settings
FOR EACH ROW
EXECUTE FUNCTION public.on_league_settings_round_change();

-- Force PostgREST to pick up the new function bodies immediately.
NOTIFY pgrst, 'reload schema';