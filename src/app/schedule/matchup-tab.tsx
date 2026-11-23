/*
 * The Matchup tab of the schedule page: the selected matchup card, its
 * scheduling / reporting / editing forms, the upcoming matches list, and the
 * completed-match history for the week.
 */
"use client";

import { MatchPredictionButton } from "@/components/match-prediction-buttons";
import { MatchupPicker } from "@/components/matchup-picker";
import { LoadingGif } from "@/components/loading-gif";
import { MemberName } from "@/components/member-name";
import {
  datePartOfInputValue,
  formatDateTimeInZone,
  formatTimeZoneLabel,
  timePartOfInputValue,
  withInputValueTime,
} from "@/lib/datetime";
import { predictionIsOpen, predictionLockMessage } from "@/lib/predictions";
import {
  formatAvailabilityWindow,
  WEEKDAY_LABELS,
  windowsForWeekday,
} from "@/lib/supabase/availability";
import * as scheduleApi from "@/lib/supabase/schedule";

import { MatchStatusBadge } from "@/components/match-status-badge";
import { MatchupHistoryCard, RosterSprites, Spoiler } from "./matchup-cards";
import { Avatar, Field, SectionCard, sideByTeamId } from "./schedule-ui";
import { type MatchupPanel } from "./use-matchup-panel";

/** Props for the {@link MatchupTab} component. */
export interface MatchupTabProps {
  goods: scheduleApi.SchedulePageGoods;
  isBusy: boolean;
  timeZone: string;
  panel: MatchupPanel;
}

/**
 * Renders the matchup card, its forms, the upcoming matches, and the week's
 * completed matches.
 *
 * @param props - {@link MatchupTabProps}
 * @returns The matchup tab.
 */
export function MatchupTab({ goods, isBusy, timeZone, panel }: MatchupTabProps) {
  const {
    selectedMatchId,
    selectedMatch,
    selectMatch,
    myMatch,
    canAct,
    canOwnerActs,
    matchPickerOptions,
    firstPlayoffWeek,
    teamRecord,
    matchFormat,
    formatFor,
    gameRows,
    playerOneRecord,
    playerTwoRecord,
    hideSpoilers,
    predictionLock: selectedPredictionLock,
    predictionPickName,
    handlePredict,
    schedulingMatchId,
    scheduleTime,
    setScheduleTime,
    scheduleNotes,
    setScheduleNotes,
    scheduleDateRef,
    isDatePickerOpen,
    handleOpenDatePicker,
    handleScheduleDateChange,
    handleScheduleDateBlur,
    openScheduling,
    handleProposeTime,
    closeScheduling,
    opponent,
    opponentAvailability,
    opponentWindows,
    isLoadingAvailability,
    availabilityError,
    scheduleFit,
    today,
    pendingProposal,
    proposalIsMine,
    proposalAuthor,
    handleRespondToProposal,
    handleCancelProposal,
    reportingMatchId,
    reportGame,
    setReportGame,
    reportWinner,
    setReportWinner,
    reportUrl,
    setReportUrl,
    reportAlive,
    setReportAlive,
    replayRead,
    setReplayRead,
    reportDifferential,
    openReporting,
    handleReadReplay,
    handleSubmitResult,
    closeReporting,
    editingResultId,
    editWinner,
    setEditWinner,
    editUrl,
    setEditUrl,
    editAlive,
    setEditAlive,
    openEditResult,
    handleSaveEditResult,
    closeEditing,
    handleForfeit,
    handleOwnerForfeit,
    handleRevertForfeit,
    upcomingWeekOptions,
    defaultUpcomingWeekKey,
    activeUpcomingWeekKey,
    setUpcomingWeekKey,
    historyWeekOptions,
    activeHistoryWeekKey,
    setHistoryWeekKey,
    upcomingMatches,
    visibleUpcomingMatches,
    completedMatches,
    visibleCompletedMatches,
  } = panel;

  return (
    <>
      <SectionCard
        title="Matchup"
        action={
          <MatchupPicker
            caption="Week / matchup"
            options={matchPickerOptions}
            selectedId={selectedMatchId}
            onSelect={(id) => selectMatch(id || null)}
          />
        }
      >
        {!selectedMatch ? (
          <p className="text-sm text-slate-400">
            No matches have been generated yet.
          </p>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col items-center gap-4 rounded-xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex w-full items-center justify-between gap-3">
                <div className="flex flex-1 flex-col items-center gap-1 text-center">
                  <Avatar
                    name={selectedMatch.player_1_name}
                    nameColor={selectedMatch.player_1_name_color}
                    avatarUrl={selectedMatch.player_1_avatar_url}
                    initials={selectedMatch.player_1_avatar_initials}
                    size={88}
                    winner={
                      !hideSpoilers &&
                      selectedMatch.winner_team_id ===
                        selectedMatch.player_1_team_id
                    }
                  />
                  <div className="flex items-center gap-1.5">
                    <MemberName
                      name={selectedMatch.player_1_name}
                      color={selectedMatch.player_1_name_color}
                      className="font-semibold text-slate-100"
                      showdownUsername={
                        selectedMatch.player_1_showdown_username
                      }
                    />
                    {teamRecord(selectedMatch.player_1_team_id) && (
                      <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                        {teamRecord(selectedMatch.player_1_team_id)}
                      </span>
                    )}
                  </div>
                  {playerOneRecord && (
                    <Spoiler hidden={hideSpoilers}>
                      <span className="text-sm text-slate-400">
                        {playerOneRecord}
                      </span>
                    </Spoiler>
                  )}
                  <div className="mt-1">
                    <RosterSprites
                      showNames
                      roster={
                        goods.rostersByTeam[
                          selectedMatch.player_1_team_id
                        ] ?? []
                      }
                    />
                  </div>
                  {goods.isCurrentSeason &&
                    selectedPredictionLock === null && (
                      <div className="mt-3 flex w-full justify-center">
                        <MatchPredictionButton
                          side={{
                            teamId: selectedMatch.player_1_team_id,
                            name: selectedMatch.player_1_name,
                          }}
                          predictedTeamId={
                            selectedMatch.my_prediction_team_id
                          }
                          predictionCounts={
                            selectedMatch.prediction_counts
                          }
                          disabled={isBusy}
                          onPick={(teamId) =>
                            void handlePredict(selectedMatch.id, teamId)
                          }
                        />
                      </div>
                    )}
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
                    vs
                  </span>
                  <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">
                    {matchFormat === "single" ? "Single" : "Best of 3"}
                  </span>
                  <MatchStatusBadge status={selectedMatch.status} />
                </div>
                <div className="flex flex-1 flex-col items-center gap-1 text-center">
                  <Avatar
                    name={selectedMatch.player_2_name}
                    nameColor={selectedMatch.player_2_name_color}
                    avatarUrl={selectedMatch.player_2_avatar_url}
                    initials={selectedMatch.player_2_avatar_initials}
                    size={88}
                    winner={
                      !hideSpoilers &&
                      selectedMatch.winner_team_id ===
                        selectedMatch.player_2_team_id
                    }
                  />
                  <div className="flex items-center gap-1.5">
                    <MemberName
                      name={selectedMatch.player_2_name}
                      color={selectedMatch.player_2_name_color}
                      className="font-semibold text-slate-100"
                      showdownUsername={
                        selectedMatch.player_2_showdown_username
                      }
                    />
                    {teamRecord(selectedMatch.player_2_team_id) && (
                      <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                        {teamRecord(selectedMatch.player_2_team_id)}
                      </span>
                    )}
                  </div>
                  {playerTwoRecord && (
                    <Spoiler hidden={hideSpoilers}>
                      <span className="text-sm text-slate-400">
                        {playerTwoRecord}
                      </span>
                    </Spoiler>
                  )}
                  <div className="mt-1">
                    <RosterSprites
                      showNames
                      roster={
                        goods.rostersByTeam[
                          selectedMatch.player_2_team_id ?? ""
                        ] ?? []
                      }
                    />
                  </div>
                  {goods.isCurrentSeason &&
                    selectedPredictionLock === null &&
                    selectedMatch.player_2_team_id && (
                      <div className="mt-3 flex w-full justify-center">
                        <MatchPredictionButton
                          side={{
                            teamId: selectedMatch.player_2_team_id,
                            name: selectedMatch.player_2_name,
                          }}
                          predictedTeamId={
                            selectedMatch.my_prediction_team_id
                          }
                          predictionCounts={
                            selectedMatch.prediction_counts
                          }
                          disabled={isBusy}
                          onPick={(teamId) =>
                            void handlePredict(selectedMatch.id, teamId)
                          }
                        />
                      </div>
                    )}
                </div>
              </div>

              {/*
               * The time line is the whole point of the agreement flow, so
               * it says which of the three states the matchup is in: no
               * time, a time waiting on the opponent, or an agreed time.
               */}
              {pendingProposal ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                  <p className="font-semibold text-amber-200">
                    {formatDateTimeInZone(
                      pendingProposal.proposed_at,
                      timeZone,
                    )}
                  </p>
                  <p className="mt-1 text-amber-200/80">
                    <MemberName
                      name={proposalAuthor.name}
                      color={proposalAuthor.color}
                    />{" "}
                    proposed this time.{" "}
                    {proposalIsMine
                      ? "Waiting for your opponent to accept."
                      : "Accept or decline it below."}
                  </p>
                </div>
              ) : selectedMatch.scheduled_at ? (
                <p className="text-sm text-slate-300">
                  {formatDateTimeInZone(
                    selectedMatch.scheduled_at,
                    timeZone,
                  )}
                  <span className="ml-2 text-xs text-emerald-300">
                    agreed by both players
                  </span>
                </p>
              ) : (
                <p className="text-sm text-slate-500">
                  No time agreed yet â€” both players have to agree before
                  this matchup is scheduled.
                </p>
              )}
              {selectedMatch.status === "forfeit" &&
                selectedMatch.forfeited_by_name && (
                  <p className="text-center text-xs text-slate-500">
                    Forfeited by{" "}
                    <MemberName
                      name={selectedMatch.forfeited_by_name}
                      color={selectedMatch.forfeited_by_name_color}
                    />
                  </p>
                )}
              {selectedMatch.notes && (
                <p className="text-sm italic text-slate-400">
                  â€œ{selectedMatch.notes}â€
                </p>
              )}

              {/*
               * Every member may predict, not just the two participants.
               * The pick is stored per match and member, and the card says
               * why it is closed rather than silently hiding the control.
               */}
              <div className="w-full rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-200">
                    Winner prediction
                  </p>
                  <span
                    className={`text-xs font-medium ${
                      goods.isCurrentSeason &&
                      selectedPredictionLock === null
                        ? "text-emerald-300"
                        : "text-slate-500"
                    }`}
                  >
                    {goods.isCurrentSeason &&
                    selectedPredictionLock === null
                      ? "Correct pick = +1 PP"
                      : "Closed"}
                  </span>
                </div>

                {selectedPredictionLock ? (
                  <p className="mt-2 text-sm text-slate-500">
                    {predictionLockMessage(selectedPredictionLock)}
                  </p>
                ) : !goods.isCurrentSeason ? (
                  <p className="mt-2 text-sm text-slate-500">
                    Predictions are closed for past seasons.
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-slate-500">
                      {selectedMatch.my_prediction_team_id
                        ? "You can change this pick until the scheduled time or the first submitted game."
                        : "Pick the team you think will win. You can change it until the scheduled time or the first submitted game."}
                    </p>
                  </>
                )}

                {selectedPredictionLock !== null ||
                !goods.isCurrentSeason ? (
                  predictionPickName ? (
                    <p className="mt-2 text-xs text-slate-400">
                      Your pick: {predictionPickName}
                    </p>
                  ) : null
                ) : null}
              </div>

              {canAct && (
                <div className="flex flex-wrap justify-center gap-2">
                  {/* The player who proposed cannot answer their own question. */}
                  {pendingProposal && !proposalIsMine ? (
                    <>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          handleRespondToProposal(
                            selectedMatch.id,
                            true,
                          )
                        }
                        className="rounded-xl bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                      >
                        Accept time
                      </button>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() =>
                          handleRespondToProposal(
                            selectedMatch.id,
                            false,
                          )
                        }
                        className="rounded-xl border border-rose-800 bg-rose-950/50 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={openScheduling}
                      className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                    >
                      {proposalIsMine
                        ? "Change proposed time"
                        : selectedMatch.scheduled_at
                          ? "Propose a new time"
                          : "Propose a time"}
                    </button>
                  )}

                  {proposalIsMine && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        handleCancelProposal(selectedMatch.id)
                      }
                      className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
                    >
                      Withdraw
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={openReporting}
                    className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
                  >
                    Add Replay
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={handleForfeit}
                    className="rounded-xl border border-rose-800 bg-rose-950/50 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
                  >
                    Forfeit
                  </button>
                </div>
              )}
            </div>

            {canOwnerActs && (
              <div className="flex flex-wrap justify-center gap-2">
                {!myMatch && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={openReporting}
                    className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
                  >
                    Add Replay
                  </button>
                )}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleOwnerForfeit("player_1")}
                  className="rounded-xl border border-rose-800 bg-rose-950/50 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
                >
                  Forfeit{" "}
                  <MemberName
                    name={selectedMatch.player_1_name}
                    color={selectedMatch.player_1_name_color}
                  />
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleOwnerForfeit("player_2")}
                  className="rounded-xl border border-rose-800 bg-rose-950/50 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
                >
                  Forfeit{" "}
                  <MemberName
                    name={selectedMatch.player_2_name}
                    color={selectedMatch.player_2_name_color}
                  />
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleOwnerForfeit("both")}
                  className="rounded-xl border border-rose-800 bg-rose-950/50 px-3.5 py-2 text-sm font-medium text-rose-300 transition hover:bg-rose-900/50 disabled:opacity-50"
                >
                  Forfeit both
                </button>
              </div>
            )}

            {goods.canEditMatchups &&
              goods.isCurrentSeason &&
              selectedMatch.status === "forfeit" && (
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={handleRevertForfeit}
                    className="rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
                  >
                    Revert forfeit
                  </button>
                </div>
              )}

            {schedulingMatchId === selectedMatch.id && (
              <div className="grid gap-4 rounded-xl border border-slate-700 bg-slate-950/60 p-4 md:grid-cols-2">
                {/*
                 * Not built with Field: that wraps its control in a
                 * <label>, and a button inside a label would activate the
                 * input as well, so the two would fight over the click.
                 */}
                <div>
                  <label
                    htmlFor="propose-date"
                    className="mb-1 block text-xs font-semibold uppercase tracking-[0.15em] text-slate-400"
                  >
                    Date ({formatTimeZoneLabel(timeZone)})
                  </label>
                  {/*
                   * The button sits against the input's right edge, between
                   * the date and the time, so the pair reads as one control
                   * and the eye lands on it from the time field.
                   */}
                  <div className="flex gap-2">
                    <input
                      id="propose-date"
                      ref={scheduleDateRef}
                      type="date"
                      value={datePartOfInputValue(scheduleTime)}
                      onChange={handleScheduleDateChange}
                      onBlur={handleScheduleDateBlur}
                      required
                      className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500 [&::-webkit-calendar-picker-indicator]:hidden"
                    />
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={handleOpenDatePicker}
                      aria-label="Open the calendar to pick a date"
                      aria-expanded={isDatePickerOpen}
                      title="Open the calendar"
                      className="shrink-0 rounded-xl border border-slate-700 bg-slate-950 px-2.5 text-slate-300 transition hover:border-amber-500 hover:text-amber-400"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        className="h-4 w-4 fill-current"
                      >
                        <path d="M7 1.8a1 1 0 0 1 1 1v1.4h8V2.8a1 1 0 1 1 2 0v1.4h1.6A2.4 2.4 0 0 1 22 6.6V9H2V6.6a2.4 2.4 0 0 1 2.4-2.4H6V2.8a1 1 0 0 1 1-1ZM2 11h20v9.4A2.4 2.4 0 0 1 19.6 23H4.4A2.4 2.4 0 0 1 2 20.4V11Zm4.5 1.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6ZM6.5 16a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Zm5.5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" />
                      </svg>
                    </button>
                  </div>
                  <span className="mt-1 block text-xs text-slate-400">
                    Pick a day. The time is separate, next to it.
                  </span>
                </div>
                <Field
                  label={`Time (${formatTimeZoneLabel(timeZone)})`}
                  hint={
                    scheduleFit === null
                      ? null
                      : scheduleFit === "inside"
                        ? "Inside the time your opponent is available."
                        : scheduleFit === "unavailable"
                          ? `${opponent?.name} marked that day unavailable.`
                          : `Outside the window ${opponent?.name} is available.`
                  }
                >
                  <input
                    type="time"
                    value={timePartOfInputValue(scheduleTime)}
                    onChange={(event) =>
                      setScheduleTime(
                        withInputValueTime(
                          scheduleTime,
                          event.target.value,
                        ),
                      )
                    }
                    required
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                  />
                </Field>
                <div className="md:col-span-2">
                  <Field label="Notes">
                    <input
                      type="text"
                      value={scheduleNotes}
                      placeholder="Replay room notes, etc."
                      onChange={(event) =>
                        setScheduleNotes(event.target.value)
                      }
                      maxLength={500}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                    />
                  </Field>
                </div>

                {/*
                 * The opponent's declared week, translated into the
                 * reader's zone so it can be compared with the input above
                 * without doing the conversion by hand.
                 */}
                <div className="md:col-span-2">
                  <p className="text-sm font-medium text-slate-300">
                    <MemberName
                      name={opponent?.name}
                      color={opponent?.color}
                      fallback="Your opponent"
                    />
                    &apos;s availability
                  </p>
                  {isLoadingAvailability ? (
                    <p className="mt-2 text-sm text-slate-500">
                      <LoadingGif label="Loading availability" />
                    </p>
                  ) : availabilityError ? (
                    <p className="mt-2 text-sm text-slate-500">
                      Availability could not be loaded. You can still
                      schedule the match.
                    </p>
                  ) : !opponentAvailability?.week ? (
                    <p className="mt-2 text-sm text-slate-500">
                      {opponent
                        ? `${opponent.name} has not set availability yet.`
                        : "Only match participants can schedule a match."}
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 text-xs text-slate-500">
                        Converted from {opponentAvailability.timeZone}{" "}
                        into your time zone (
                        {formatTimeZoneLabel(timeZone)}).
                      </p>
                      <div className="mt-3 space-y-1.5">
                        {WEEKDAY_LABELS.map((label, dayOfWeek) => {
                          const dayWindows = windowsForWeekday(
                            opponentWindows,
                            dayOfWeek,
                          );

                          return (
                            <div
                              key={dayOfWeek}
                              className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm ${
                                dayOfWeek === today
                                  ? "border-amber-500/50 bg-slate-900"
                                  : "border-slate-800 bg-slate-950/50"
                              }`}
                            >
                              <span className="text-slate-300">
                                {label}
                                {dayOfWeek === today && (
                                  <span className="ml-2 text-xs text-amber-400">
                                    today
                                  </span>
                                )}
                              </span>
                              <span className="text-right text-slate-400">
                                {dayWindows.length === 0
                                  ? "Unavailable"
                                  : dayWindows
                                      .map((window) =>
                                        formatAvailabilityWindow(
                                          window,
                                        ),
                                      )
                                      .join(", ")}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>

                <div className="flex gap-2 md:col-span-2">
                  <button
                    type="button"
                    disabled={
                      isBusy || !timePartOfInputValue(scheduleTime)
                    }
                    onClick={handleProposeTime}
                    className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                  >
                    Send proposal
                  </button>
                  <button
                    type="button"
                    onClick={closeScheduling}
                    className="rounded-xl border border-slate-700 px-3.5 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {reportingMatchId === selectedMatch.id && (
              <div className="grid gap-4 rounded-xl border border-slate-700 bg-slate-950/60 p-4 md:grid-cols-2">
                <Field label="Game">
                  <select
                    value={reportGame}
                    onChange={(event) =>
                      setReportGame(event.target.value)
                    }
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                  >
                    {[1, 2, 3]
                      .slice(0, matchFormat === "single" ? 1 : 3)
                      .filter(
                        (game) =>
                          !selectedMatch.results.some(
                            (result) => result.game_number === game,
                          ),
                      )
                      .map((game) => (
                        <option key={game} value={game}>
                          Game {game}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Winner">
                  <select
                    value={reportWinner}
                    onChange={(event) =>
                      setReportWinner(event.target.value)
                    }
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                  >
                    <option value="">Select the winner</option>
                    <option value={selectedMatch.player_1_team_id}>
                      {selectedMatch.player_1_name}
                    </option>
                    {selectedMatch.player_2_team_id && (
                      <option value={selectedMatch.player_2_team_id}>
                        {selectedMatch.player_2_name}
                      </option>
                    )}
                  </select>
                </Field>
                <Field
                  label="Replay link (optional)"
                  hint={
                    replayRead.status === "loading"
                      ? "Reading the battle log..."
                      : null
                  }
                >
                  <input
                    type="url"
                    value={reportUrl}
                    placeholder="https://replay.pokemonshowdown.com/..."
                    maxLength={500}
                    onChange={(event) => {
                      setReportUrl(event.target.value);
                      setReplayRead({ status: "idle" });
                    }}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                  />
                </Field>
                <Field
                  label="Winner's surviving Pokemon (optional)"
                  hint={
                    reportDifferential == null
                      ? null
                      : `Your KO differential for this game: ${reportDifferential > 0 ? "+" : ""}${reportDifferential}`
                  }
                >
                  <input
                    type="number"
                    min={0}
                    max={6}
                    step={1}
                    value={reportAlive}
                    onChange={(event) =>
                      setReportAlive(
                        event.target.value.replace(/[^0-9]/g, ""),
                      )
                    }
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2 md:col-span-2">
                  <button
                    type="button"
                    onClick={handleReadReplay}
                    disabled={
                      isBusy ||
                      !reportUrl.trim() ||
                      replayRead.status === "loading"
                    }
                    className="rounded-xl border border-amber-500/60 px-3.5 py-2 text-sm font-semibold text-amber-300 transition hover:border-amber-400 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Read replay
                  </button>
                  {replayRead.status === "done" &&
                    (replayRead.note ? (
                      <span className="text-xs text-amber-300">
                        {replayRead.note}
                      </span>
                    ) : replayRead.winnerResolved ? (
                      <span className="text-xs text-emerald-300">
                        Filled in the winner and surviving Pokemon from
                        the replay. Check them before submitting.
                      </span>
                    ) : (
                      <span className="text-xs text-amber-300">
                        Winner could not be matched to a team. Set it
                        manually.
                      </span>
                    ))}
                </div>
                <div className="flex gap-2 md:col-span-2">
                  <button
                    type="button"
                    disabled={isBusy || !reportWinner}
                    onClick={handleSubmitResult}
                    className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Submit result
                  </button>
                  <button
                    type="button"
                    onClick={closeReporting}
                    className="rounded-xl border border-slate-700 px-3.5 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {gameRows.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Games
                </h3>
                <div className="space-y-2">
                  {gameRows.map(({ result, mirrored }) => {
                    const winner = sideByTeamId(
                      selectedMatch,
                      result.winner_team_id,
                    );
                    if (editingResultId === result.id) {
                      return (
                        <div
                          key={result.id}
                          className="grid gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4 md:grid-cols-3"
                        >
                          <Field label="Winner">
                            <select
                              value={editWinner}
                              onChange={(event) =>
                                setEditWinner(event.target.value)
                              }
                              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                            >
                              <option
                                value={selectedMatch.player_1_team_id}
                              >
                                {selectedMatch.player_1_name}
                              </option>
                              {selectedMatch.player_2_team_id && (
                                <option
                                  value={selectedMatch.player_2_team_id}
                                >
                                  {selectedMatch.player_2_name}
                                </option>
                              )}
                            </select>
                          </Field>
                          <Field label="Replay link">
                            <input
                              type="url"
                              value={editUrl}
                              maxLength={500}
                              onChange={(event) =>
                                setEditUrl(event.target.value)
                              }
                              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                            />
                          </Field>
                          <Field label="Surviving Pokemon">
                            <input
                              type="number"
                              min={0}
                              max={6}
                              step={1}
                              value={editAlive}
                              onChange={(event) =>
                                setEditAlive(
                                  event.target.value.replace(
                                    /[^0-9]/g,
                                    "",
                                  ),
                                )
                              }
                              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500"
                            />
                          </Field>
                          <div className="flex gap-2 md:col-span-3">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleSaveEditResult(result)
                              }
                              className="rounded-xl bg-amber-500 px-3.5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
                            >
                              Save edit
                            </button>
                            <button
                              type="button"
                              onClick={closeEditing}
                              className="rounded-xl border border-slate-700 px-3.5 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={result.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-300">
                            Game {result.game_number}
                          </span>
                          <Spoiler hidden={hideSpoilers}>
                            <span className="font-semibold text-emerald-300">
                              <MemberName
                                name={winner.name}
                                color={winner.color}
                                className="font-semibold text-emerald-300"
                              />{" "}
                              wins
                            </span>
                          </Spoiler>
                          {result.pokemon_left_alive != null && (
                            <Spoiler hidden={hideSpoilers}>
                              <span className="text-slate-400">
                                â€¢ {result.pokemon_left_alive} alive
                              </span>
                            </Spoiler>
                          )}
                          {result.reporter_name && (
                            <span className="text-xs text-slate-500">
                              Submitted by{" "}
                              <MemberName
                                name={result.reporter_name}
                                color={result.reporter_name_color}
                              />
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {result.replay_url && (
                            <a
                              href={result.replay_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sky-400 underline decoration-sky-700 hover:text-sky-300"
                            >
                              Replay
                            </a>
                          )}
                          {/* A mirrored game has no stored result to correct. */}
                          {goods.isStaff && !mirrored && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => openEditResult(result)}
                              className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Upcoming matches"
        action={
          upcomingWeekOptions.length > 0 ? (
            <select
              aria-label="Week"
              value={activeUpcomingWeekKey ?? ""}
              onChange={(event) =>
                setUpcomingWeekKey(event.target.value)
              }
              className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
            >
              {upcomingWeekOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                  {option.key === defaultUpcomingWeekKey
                    ? " (current)"
                    : ""}
                </option>
              ))}
            </select>
          ) : null
        }
      >
        {upcomingMatches.length === 0 ? (
          <p className="text-sm text-slate-400">
            No upcoming matches in the regular season.
          </p>
        ) : visibleUpcomingMatches.length === 0 ? (
          <p className="text-sm text-slate-400">
            No upcoming matches in this week.
          </p>
        ) : (
          <div className="space-y-2">
            {visibleUpcomingMatches.map((match) => (
              <div
                key={match.id}
                className={`rounded-xl border p-3 transition ${
                  selectedMatchId === match.id
                    ? "border-amber-500/60 bg-slate-800/80"
                    : "border-slate-700 bg-slate-800/50 hover:bg-slate-800"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectMatch(match.id)}
                  className="flex w-full flex-col text-left"
                >
                  <div className="flex w-full items-start justify-between gap-3">
                    <p className="font-semibold text-slate-100">
                      {scheduleApi.matchWeekLabel(match, firstPlayoffWeek)}
                    </p>
                    <MatchStatusBadge status={match.status} />
                  </div>
                  {match.scheduled_at && (
                    <p className="mt-0.5 text-sm text-slate-400">
                      {formatDateTimeInZone(
                        match.scheduled_at,
                        timeZone,
                      )}
                    </p>
                  )}
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 flex-col items-center">
                      <div className="flex min-w-0 max-w-full items-center justify-center gap-2">
                        <Avatar
                          name={match.player_1_name}
                          nameColor={match.player_1_name_color}
                          avatarUrl={match.player_1_avatar_url}
                          initials={match.player_1_avatar_initials}
                          size={48}
                        />
                        <div className="flex min-w-0 items-center gap-1.5">
                          <MemberName
                            name={match.player_1_name}
                            color={match.player_1_name_color}
                            className="min-w-0 truncate text-xs font-medium text-slate-400"
                            showdownUsername={
                              match.player_1_showdown_username
                            }
                          />
                          {teamRecord(match.player_1_team_id) && (
                            <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                              {teamRecord(match.player_1_team_id)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 w-full">
                        <RosterSprites
                          roster={
                            goods.rostersByTeam[
                              match.player_1_team_id
                            ] ?? []
                          }
                          splitRows
                        />
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center justify-center self-center text-center text-xs font-bold uppercase tracking-widest text-slate-500">
                      vs
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col items-center">
                      <div className="flex min-w-0 max-w-full items-center justify-center gap-2">
                        <Avatar
                          name={match.player_2_name}
                          nameColor={match.player_2_name_color}
                          avatarUrl={match.player_2_avatar_url}
                          initials={match.player_2_avatar_initials}
                          size={48}
                        />
                        <div className="flex min-w-0 items-center gap-1.5">
                          <MemberName
                            name={match.player_2_name}
                            color={match.player_2_name_color}
                            className="min-w-0 truncate text-xs font-medium text-slate-400"
                            showdownUsername={
                              match.player_2_showdown_username
                            }
                          />
                          {teamRecord(match.player_2_team_id) && (
                            <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                              {teamRecord(match.player_2_team_id)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 w-full">
                        <RosterSprites
                          roster={
                            goods.rostersByTeam[
                              match.player_2_team_id ?? ""
                            ] ?? []
                          }
                          splitRows
                        />
                      </div>
                    </div>
                  </div>
                </button>

                {goods.isCurrentSeason && predictionIsOpen(match) ? (
                  <div className="mt-2 border-t border-slate-700/60 pt-2">
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
                      Winner prediction
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="flex justify-center">
                        <MatchPredictionButton
                          side={{
                            teamId: match.player_1_team_id,
                            name: match.player_1_name,
                          }}
                          predictedTeamId={match.my_prediction_team_id}
                          predictionCounts={match.prediction_counts}
                          disabled={isBusy}
                          onPick={(teamId) =>
                            void handlePredict(match.id, teamId)
                          }
                        />
                      </div>
                      <div className="flex justify-center">
                        {match.player_2_team_id && (
                          <MatchPredictionButton
                            side={{
                              teamId: match.player_2_team_id,
                              name: match.player_2_name,
                            }}
                            predictedTeamId={
                              match.my_prediction_team_id
                            }
                            predictionCounts={match.prediction_counts}
                            disabled={isBusy}
                            onPick={(teamId) =>
                              void handlePredict(match.id, teamId)
                            }
                          />
                        )}
                      </div>
                    </div>
                  </div>
                ) : match.my_prediction_team_id ? (
                  <p className="mt-2 border-t border-slate-700/60 pt-2 text-xs font-medium text-amber-200/80">
                    Your pick:{" "}
                    {match.my_prediction_team_id ===
                    match.player_1_team_id
                      ? match.player_1_name
                      : match.player_2_name}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Match history"
        action={
          historyWeekOptions.length > 0 ? (
            <select
              aria-label="Week"
              value={activeHistoryWeekKey ?? ""}
              onChange={(event) =>
                setHistoryWeekKey(event.target.value)
              }
              className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
            >
              {historyWeekOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null
        }
      >
        {completedMatches.length === 0 ? (
          <p className="text-sm text-slate-400">
            No completed matchups yet.
          </p>
        ) : visibleCompletedMatches.length === 0 ? (
          <p className="text-sm text-slate-400">
            No completed matchups in this week.
          </p>
        ) : (
          <div className="space-y-3">
            {visibleCompletedMatches.map((match) => (
              <MatchupHistoryCard
                key={match.id}
                match={match}
                matchFormat={formatFor(match)}
                timeZone={timeZone}
                hideSpoilers={hideSpoilers}
                selected={selectedMatchId === match.id}
                rostersByTeam={goods.rostersByTeam}
                firstPlayoffWeek={firstPlayoffWeek}
                onSelect={() => selectMatch(match.id)}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </>
  );
}
