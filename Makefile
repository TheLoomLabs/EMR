.DEFAULT_GOAL := help

.PHONY: help install dev dev-firefox build build-firefox build-all zip zip-firefox test compile check clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*##"}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

dev: ## Run the dev server for Chrome, with hot reload
	npm run dev

dev-firefox: ## Run the dev server for Firefox, with hot reload
	npm run dev:firefox

build: ## Build the Chrome extension into .output/chrome-mv3
	npm run build

build-firefox: ## Build the Firefox extension into .output/firefox-mv3
	npm run build:firefox

build-all: build build-firefox ## Build both Chrome and Firefox

zip: ## Zip the Chrome build for distribution
	npm run zip

zip-firefox: ## Zip the Firefox build for distribution
	npm run zip:firefox

test: ## Run the test suite
	npm run test

compile: ## Typecheck without emitting output
	npm run compile

check: compile test ## Typecheck and run the test suite

clean: ## Remove build output and generated WXT types
	rm -rf .output .wxt
