// Channel modes (ADR-0002, docs/architecture-integrations.md §3-§4, docs/build-plan.md WP-02).
//
// The mode is PER WORLD (`Worlds/W#<w>#WORLD/SETTINGS.channelModes.whatsapp`); this module only holds
// the allowlist of worlds that may ever run WhatsApp `live` and the explicit approval that allows it:
//
//   email      always `live`: SES end to end, synthetic customers are SES mailbox simulator
//              addresses; outbound only (ADR-0003).
//   whatsapp   `simulated` in every world (the phone simulator of the console feeds the same inbound
//              normalizer as the SNS payload of End User Messaging Social) except the worlds listed in
//              `liveWorlds`. A world may be listed only together with `whatsappLiveApproval` (ISO
//              date and approver role), and only `demo` and the QA live world pattern `qa-live-*` of
//              SC-23 may ever be listed: guest, `gtest`, `qa-*` and `sim-*` worlds are always simulated.
//
// Exposed as a Linkable so every Lambda reads it with `Resource.ChannelModes` (through `readLinked`),
// never from `process.env`. `npm run channels:check-modes` (CI) fails when `liveWorlds` is not empty
// without an approval, or when it lists a world that is neither `demo` nor `qa-live-*`, so keep the
// email mode a plain string literal on its own line, `liveWorlds` a literal array of strings and the
// approval either `null` or an object literal with string `date` and `approver`.

export const whatsappLiveApproval: { readonly date: string; readonly approver: string } | null = null;

export const channelModes = {
  email: "live",
  whatsapp: {
    liveWorlds: [] as string[], // set together with whatsappLiveApproval, in a reviewed PR
  },
};

export const ChannelModes = new sst.Linkable("ChannelModes", {
  properties: channelModes,
});
