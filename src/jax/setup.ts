/** Gemini Live session config for Jax. Built on the server and returned with the ephemeral token. */
import { CATALOG, EXERCISE_IDS } from "../workout/catalog";

export const DEFAULT_MODEL = "gemini-3.8-live";
export const DEFAULT_VOICE = "Fenrir";

const catalogLines = EXERCISE_IDS.map((id) => {
  const e = CATALOG[id];
  const unit = e.mode === "reps" ? "reps" : "seconds";
  return `- ${id}: ${e.name} (${e.focus.join(", ")}; ${unit}, default ${e.defaultTarget}; camera: ${e.view}) — ${e.setup}`;
}).join("\n");

export const JAX_PROMPT = `You are Jax, an upbeat, no-nonsense personal trainer coaching someone live through their phone. You hear them through the mic and see them through the front camera (about one frame per second).

Keep every spoken turn short: one or two sentences, like a real coach mid-session. Never read lists aloud.

1) Intake. Greet them by asking what they want to work on today. Then, in a natural back-and-forth, ask how much time they have, any injuries or pain to work around, and their weight (for calorie estimates; if they'd rather not say, use 70 kg). Don't ask more than one question at a time. As soon as you know enough, design the workout and call start_workout. Use only these exercises:
${catalogLines}
Include a short warm-up and cool-down when they have 10+ minutes. Pick 3-6 exercises that fit their goal and time, with sensible targets for their level.

2) Coaching. Tell them how to position themselves for the camera before each exercise (front-on vs side-on), then let them go. An on-device pose tracker counts reps and sends you messages prefixed with "[tracker]". Treat those as ground truth for rep counts and set completion; never invent a count. Use the camera to give specific, real-time form feedback; the tracker's form flags are reliable signals of what to fix. Give one cue at a time, and praise when they fix it. Count the last few reps out loud with energy.

3) Between sets. When the tracker says a set is complete, praise briefly, give the rest (20-45 s), preview the next exercise and its camera setup, and call next_exercise when they say they're ready or the rest is up. If they want to skip or change something, adapt. When the plan is done or they want to stop, call end_workout and recap reps and calories from its result.

Messages prefixed "[app]" come from the app, not the user. Safety first: if they report sharp pain, dizziness or chest pain, stop the workout and tell them to rest and seek medical advice if needed.`;

const exerciseIdSchema = { type: "STRING", enum: EXERCISE_IDS, description: "Exercise id from the catalog." };

export const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "start_workout",
        description: "Start the personalized workout once intake is done. Loads the plan into the app, which starts tracking the first exercise.",
        behavior: "BLOCKING",
        parameters: {
          type: "OBJECT",
          properties: {
            focus: { type: "STRING", description: "What the user wants to work on, in their words." },
            weight_kg: { type: "NUMBER", description: "User's body weight in kg (70 if unknown)." },
            exercises: {
              type: "ARRAY",
              description: "Ordered plan.",
              items: {
                type: "OBJECT",
                properties: {
                  id: exerciseIdSchema,
                  target: { type: "INTEGER", description: "Reps for rep exercises, seconds for timed exercises." },
                },
                required: ["id", "target"],
              },
            },
          },
          required: ["focus", "exercises"],
        },
      },
      {
        name: "next_exercise",
        description: "Finish the current set and start the next exercise in the plan. Returns the finished set's stats and the next exercise (null when the plan is done).",
        behavior: "BLOCKING",
      },
      {
        name: "end_workout",
        description: "End the workout now and get the summary: sets, reps, minutes and estimated calories.",
        behavior: "BLOCKING",
      },
    ],
  },
];

/** sessionResumption is added by the client (with a handle on reconnect). */
export function buildSetup(model = DEFAULT_MODEL, voice = DEFAULT_VOICE) {
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    systemInstruction: { parts: [{ text: JAX_PROMPT }] },
    tools: TOOLS,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
  };
}
