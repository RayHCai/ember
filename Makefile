.PHONY: setup app dev phones bundle test

# Install the web and desktop app dependencies.
setup:
	npm --prefix web install

# Run Ember as a desktop app (dummy data built in).
app:
	npm --prefix web run tauri dev

# Run the console in a browser instead, for debugging.
dev:
	npm --prefix web run dev

# Serve the resident alert page to phones on the same Wi-Fi. Open the
# "Network" address it prints, plus /alert, on a phone.
phones:
	cd web && npx vite --host --port 5180

# Build Ember.app.
bundle:
	npm --prefix web run tauri build
	@echo "Built: web/src-tauri/target/release/bundle/macos/Ember.app"

# Typecheck and run the browser tests.
test:
	npm --prefix web test
