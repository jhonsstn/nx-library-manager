# DBI MTP inventory validation on Windows

The automated Windows package smoke test checks that the inventory script is bundled and the parser runs. A connected Switch is needed to validate DBI's actual virtual filenames and absence results.

1. Start DBI's **Run MTP responder**, connect one Switch, and confirm **4: Installed games** is visible in Windows Explorer.
2. Open a game's folder under **4: Installed games** and record the displayed names of its base, update, and DLC entries. Use a game with a known update and DLC. The app reads only these names; it does not copy the files. Sharing the names does not require `prod.keys`.
3. Open the packaged portable app and select the same game in the local library. Press **Refresh Switch**. Check that the inventory moves from **Checking Switch** to **ready** or **partial**, and that the base, update raw version, and DLC rows match the Explorer listing by Title ID.
4. Check a game that is not on the Switch. **Not installed** and **Ready to install** should appear only after a complete scan. An unrecognized name must produce a partial scan and **unknown** absence.
5. Open **Install missing local content**. Only the newest verified local update and missing local DLC files should be selected. A combined package appears once and discloses installed content it also carries. Public-only DLC has no install option.
6. Transfer one selected package. The app should show **Checking Switch** after the batch. Confirm the newly installed state appears only after a fresh scan. Disconnect the cable; the inventory should disappear.
7. Repeat with two Switch MTP devices attached. The app must refuse inventory and MTP install destinations until one is disconnected.

If step 3 remains **partial**, capture the names shown by Explorer, including extensions if visible, and the app's inventory message. This is the evidence needed to adjust the DBI filename rules before relying on negative results.
