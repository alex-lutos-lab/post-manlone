const { createApp } = Vue;

createApp({
    // DATA: This defines the "state" of your app (the variables)
    data() {
        return {
            
            // UI State
            activeTab: 'runner',
            environments: [],
            activeEnv: null,
            editingEnv: null,
            tempkeys: {},
            loading: false,
            
            // Collection Identity
            activeCollectionName: 'Default',
            collections: [], // Changed to an array to match DB rows

            // Request Configuration (Populated by DB on load)
            url: '',
            selectedMethod: 'POST',
            headers: '{\n  "Content-Type": "application/json"\n}',
            payloadText: '[]',
            iterations: 1,

            // Output & Logs
            logs: [],
            results: [],
            responseBody: '',

            // Edit mode
            isEditingName: false,
            editingName: ''
        }
},

    async mounted() {
        this.loadEnvironments();
        this.loadCollection();
        
    try {
        const resp = await fetch('http://localhost:5000/api/collections');
        if (!resp.ok) throw new Error("Failed to fetch from server");
        
        const data = await resp.json();
        this.collections = data; // Store the full list for dropdowns/sidebars

        if (this.collections.length > 0) {
            // Load the most recently used/first collection
            const col = this.collections[0];
            
            this.activeCollectionName = col.name;
            this.url = col.url;
            this.selectedMethod = col.method;
            this.headers = col.headers;
            this.payloadText = col.payload;
            this.iterations = col.iterations || 1;
            
            console.log(`🚀 Loaded collection: ${col.name}`);
        }
    } catch (err) {
        console.error("📡 Connection Error:", err.message);
        // Optional: show a small UI notification that the server is offline
    }
},

    // METHODS: This defines the "actions" your app can take
    methods: {
        // Helper to replace variables in a string
        parseTemplate(text) {
            if (!text || !this.activeEnv || !this.activeEnv.variables) return text;

            let processed = text;
            const vars = this.activeEnv.variables;

            // Loop through all keys in the active environment
            Object.keys(vars).forEach(key => {
                const placeholder = `{{${key}}}`;
                const value = vars[key];
                // Replace all instances of the placeholder with the actual value
                processed = processed.split(placeholder).join(value);
            });

            return processed;
        },

        async runTest() {
            // 1. Process the URL and Payload with variables
            const finalUrl = this.parseTemplate(this.activeRequest.url);
            const finalPayload = this.parseTemplate(this.activeRequest.payload);
            
            // 2. Now use finalUrl and finalPayload in your fetch() call
            console.log("🚀 Actually fetching:", finalUrl);
            
            try {
                const response = await fetch(finalUrl, {
                    method: this.activeRequest.method,
                    headers: { 'Content-Type': 'application/json' },
                    body: this.activeRequest.method !== 'GET' ? finalPayload : null
                });
                
                // ... existing response handling
            } catch (err) {
                console.error("Request Failed:", err);
            }

        },

        // applyCollection is the primary "loader"
        applyCollection(col) {
            if (!col) return;

            this.activeCollectionName = col.name;
            this.url = col.url;
            this.selectedMethod = col.method || 'POST';
            this.headers = col.headers;
            this.payloadText = col.payload;
            
            // Ensure iterations is a number and has a fallback
            this.iterations = parseInt(col.iterations) || 1;
        },

        async persistToServer() {
            try {
                const response = await fetch('http://localhost:5000/api/save-collection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: this.activeCollectionName,
                        url: this.url,
                        method: this.selectedMethod,
                        headers: this.headers,
                        payload: this.payloadText, // Just the raw text, no brackets added here
                        iterations: parseInt(this.iterations) || 1
                    })
                });
                
                if (response.ok) console.log("✅ Saved raw payload");
            } catch (err) {
                console.error("Save Error:", err.message);
            }
        },

        getLogClass(type) {
            switch (type) {
                case 'success': return 'text-green-400 font-medium';
                case 'error':   return 'text-red-400 font-bold';
                case 'info':    return 'text-yellow-400 border-b border-gray-800 pb-1 mt-2 block';
                default:        return 'text-blue-400';
            }
        },

        async runRequests() {
            this.loading = true;
            this.logs = []; 
            this.results = []; // Clear results tab too

            try {
                // 1. AUTO-SAVE: Persist current state
                await this.persistToServer();

                // --- NEW STEP: APPLY ENVIRONMENT VARIABLES ---
                // We process the URL and Payloads before sending them to the batch runner
                const processedUrl = this.applyVariables(this.url);
                const processedPayloads = this.applyVariables(this.payloadText);
                const processedHeaders = this.applyVariables(this.headers); // Optional: if you use variables in headers

                console.log("🚀 Batch running on:", processedUrl);

                // 2. TRIGGER BATCH: Send the PROCESSED data to the server
                const response = await fetch('http://localhost:5000/api/run-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: processedUrl,         // Use processed version
                        method: this.selectedMethod,
                        headers: processedHeaders,  // Use processed version
                        payloads: processedPayloads, // Use processed version
                        iterations: parseInt(this.iterations) || 1
                    })
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n\n');
                    
                    lines.forEach(line => {
                        if (line.startsWith('data: ')) {
                            try {
                                const logData = JSON.parse(line.replace('data: ', ''));
                                
                                // Push to terminal
                                this.logs.push(logData); 

                                // Update results & last response body
                                if (logData.body) {
                                    this.results.push(logData);
                                    this.responseBody = JSON.stringify(logData.body, null, 2);
                                }

                                // Auto-scroll logic
                                this.$nextTick(() => {
                                    const term = document.getElementById('terminal');
                                    if (term) term.scrollTop = term.scrollHeight;
                                });
                            } catch (e) {
                                console.error("Stream line parse error:", e);
                            }
                        }
                    });
                }
            } catch (err) {
                this.logs.push({ message: `❌ Connection Error: ${err.message}`, type: 'error' });
            } finally {
                this.loading = false;
            }
        },

        // Save current fields into the active collection
        async saveCollection() {
            try {
                // 1. Reuse our persistence logic to keep things DRY (Don't Repeat Yourself)
                await this.persistToServer();

                // 2. Fetch the updated list from the server 
                // This ensures the 'collections' array in Vue matches the DB perfectly
                const resp = await fetch('http://localhost:5000/api/collections');
                if (resp.ok) {
                    this.collections = await resp.json();
                }

                // 3. User Feedback
                console.log(`✅ Collection "${this.activeCollectionName}" saved to SQLite.`);
                
                // Optional: A non-intrusive alert or toast
                alert(`Saved: ${this.activeCollectionName}`);

            } catch (err) {
                console.error("❌ Save Error:", err);
                alert("Failed to save. Check if the Node.js server is running.");
            }
        },

        // Load data from the selected collection into the UI fields
        loadCollection() {
            // 1. Find the collection in our array that matches the active name
            const col = this.collections.find(c => c.name === this.activeCollectionName);

            if (col) {
                // 2. Map the database fields to the UI state
                this.url = col.url;
                this.selectedMethod = col.method || 'POST';
                this.headers = col.headers;
                this.payloadText = col.payload;
                
                // 3. Don't forget iterations!
                this.iterations = col.iterations || 1;

                console.log(`📖 Loaded: ${col.name}`);
            } else {
                console.warn("Collection not found in local list.");
            }
        },

        async addNewCollection() {
            const name = prompt("Enter Collection Name (e.g., 'Login API', 'User Creation'):");
            
            if (!name) return;

            // 1. Check if the name already exists in our array
            const exists = this.collections.some(c => c.name === name);

            if (exists) {
                alert("A collection with that name already exists!");
                return;
            }

            // 2. Set the UI to a "Blank Slate" for the new collection
            this.activeCollectionName = name;
            this.url = '';
            this.selectedMethod = 'POST';
            this.headers = '{\n  "Content-Type": "application/json"\n}';
            this.payloadText = ''; // No brackets, as we discussed!
            this.iterations = 1;

            // 3. Immediately persist this new "Blank" collection to SQLite
            await this.saveCollection();
            
            console.log(`✨ Created and saved new collection: ${name}`);
        },

        // async renameAndSave() {
        //     const oldName = this.activeCollectionName;
        //     const newName = prompt("Enter new name for this collection:", oldName);

        //     // Validation: Don't do anything if they cancel or keep the name the same
        //     if (!newName || newName === oldName || newName.trim() === "") return;

        //     try {
        //         const response = await fetch ('http://localhost:5000/api/collections/rename', {
        //             method: 'PUT',
        //             headers: { 'Content-Type': 'application/json' },
        //             body: JSON.stringify({ oldName, newName })
        //         });

        //         if (!response.ok) throw new Error("Rename failed on server");

        //         // Update the local list WITHOUT re-fetching everything
        //         const item = this.collections.find(c => c.name === oldName);
        //         if (item) {
        //             item.name = newName;
        //         }

        //         // Update the pointer
        //         this.activeCollectionName = newName;

                
        //         // Refresh the list from the server
        //         const resp = await fetch('http://localhost:5000/api/collections');
        //         // const data = await resp.json();
                
        //         // Update the array first
        //         // this.collections = data;
        //         this.collections = await resp.json();

        //         // THE FIX: Explicitly re-set the active name 
        //         // This forces the dropdown to find the matching entry in the new list
        //         setTimeout(() => {
        //             this.activeCollectionName = newName;
        //             console.log("Forcing dropdown to:", this.activeCollectionName);
        //         }, 50);
                

        //         console.log(`📝 Renamed "${oldName}" to "${newName}"`);

        //     } catch (err) {
        //         console.error("Rename Error:", err);
        //         // Revert UI name if the save fails
        //         this.activeCollectionName = oldName;
        //         alert("Failed to rename. Check server connection.");
        //     }
        // },

        async deleteCollection() {
            const nameToDelete = this.activeCollectionName;

            // 1. Guard rail for the Default collection
            if (nameToDelete === 'Default') {
                return alert("The 'Default' collection is protected and cannot be deleted.");
            }

            // 2. Confirm with the user
            if (!confirm(`Are you sure you want to permanently delete "${nameToDelete}"?`)) {
                return;
            }

            try {
                // 3. Send DELETE request to the server
                const response = await fetch(`http://localhost:5000/api/delete-collection/${encodeURIComponent(nameToDelete)}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    // 4. Update the local array to remove the deleted item
                    this.collections = this.collections.filter(c => c.name !== nameToDelete);
                    
                    // 5. Reset to Default and load it
                    this.activeCollectionName = 'Default';
                    this.loadCollection();
                    
                    console.log(`🗑️ Deleted collection: ${nameToDelete}`);
                    alert(`"${nameToDelete}" has been removed.`);
                } else {
                    const errorData = await response.json();
                    throw new Error(errorData.error || "Failed to delete from database");
                }
            } catch (err) {
                console.error("❌ Delete Error:", err);
                alert("Error deleting collection. Is the server running?");
            }
        },

        startRename() {
            if (this.activeCollectionName === 'Default') return;
            
            this.editingName = this.activeCollectionName;
            this.isEditingName = true;
            
            // Auto-focus the input after the DOM updates
            this.$nextTick(() => {
                this.$refs.renameInput?.focus();
            });
        },

        cancelRename() {
            this.isEditingName = false;
            this.editingName = '';
        },

        async confirmRename() {
            console.log("confirm rename")
            const oldName = this.activeCollectionName;
            const newName = this.editingName.trim();

            if (!newName || newName === oldName) {
                return this.cancelRename();
            }

            console.log("Attempting fetch...");
            

            try {
                console.log("confirm rename 2")
                const response = await fetch('http://localhost:5000/api/collections/rename', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldName, newName })
                });
                
                console.log("Fetch settled. Status:", response.status);

                if (response.ok) {
                    // Update the list item
                    const item = this.collections.find(c => c.name === oldName);
                    if (item) item.name = newName;

                    // Update the pointer and close editor
                    this.activeCollectionName = newName;

                    console.log("Rename Successful")
                    // Flip the toggle back to show the dropdown/text view
                    this.isEditingName = false;
                }
            } catch (err) {
                console.error("Rename failed:", err);
            }
        },

        selectEnvToEdit(env) {
            // We use JSON.parse(JSON.stringify()) to create a "Deep Copy"
            // This way, if you change text but don't hit Save, the original data isn't ruined
            this.editingEnv = JSON.parse(JSON.stringify(env));
            
            // Sync the temporary keys used for renaming
            this.tempKeys = {};
            Object.keys(this.editingEnv.variables).forEach(k => {
                this.tempKeys[k] = k;
            });
        },

        addNewVariable() {
            const newKey = "new_variable_" + Date.now();
            this.editingEnv.variables[newKey] = "";
            this.tempKeys[newKey] = "new_variable";
        },

        deleteVariable(key) {
            delete this.editingEnv.variables[key];
            delete this.tempKeys[key];
        },

        async loadEnvironments() {
            try {
                const response = await fetch('http://localhost:5000/api/environments');
                if (response.ok) {
                    const data = await response.json();
                    // Map the data to ensure variables are parsed if the backend sends them as strings
                    this.environments = data.map(env => ({
                        ...env,
                        variables: typeof env.variables === 'string' ? JSON.parse(env.variables) : env.variables
                    }));
                    console.log("Environments loaded:", this.environments);
                }
            } catch (err) {
                console.error("Failed to load environments:", err);
            }
        },

        async saveEnvironment() {
            try {
                const response = await fetch('http://localhost:5000/api/environments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: this.editingEnv.name,
                        variables: this.editingEnv.variables
                    })
                });
                if (response.ok) {
                    await this.loadEnvironments(); // Refresh the list
                    alert("Environment Saved!");
                }
            } catch (err) {
                console.error(err);
            }
        },

        savePreferenceLocally() {
            if (this.activeEnv) {
                // Save the ID so we can look it up on next page load
                localStorage.setItem('activeEnvId', this.activeEnv.id);
                console.log(`Preference saved: ${this.activeEnv.name}`);
            } else {
                localStorage.removeItem('activeEnvId');
            }
        },

        // You should call this inside your 'mounted' hook or after loading environments
        restorePreference() {
            const savedId = localStorage.getItem('activeEnvId');
            if (savedId && this.environments.length > 0) {
                const found = this.environments.find(e => e.id == savedId);
                if (found) this.activeEnv = found;
            }
        },

        createNewEnv() {
            // 1. Create a fresh template
            const newEnv = {
                id: null, // No ID yet since it's not in the DB
                name: 'New Environment',
                variables: {
                    "base_url": "https://api.example.com" // Provide a default to help the user
                }
            };

            // 2. Set it as the one we are currently editing
            this.editingEnv = newEnv;

            // 3. Initialize tempKeys for the new variables
            this.tempKeys = {
                "base_url": "base_url"
            };

            console.log("Creating new environment template...");
        },

        applyVariables(text) {
            if (!text) return text;
            if (!this.activeEnv) {
                console.warn("⚠️ No active environment selected!");
                return text;
            }

            let processedText = text;
            const variables = this.activeEnv.variables;

            // This looks for anything inside double curly braces: {{example}}
            Object.keys(variables).forEach(key => {
                const placeholder = `{{${key}}}`;
                const value = variables[key];
                
                // We use .split().join() to replace ALL occurrences in the string
                if (processedText.includes(placeholder)) {
                    console.log(`✨ Replacing ${placeholder} with ${value}`);
                    processedText = processedText.split(placeholder).join(value);
                }
            });

            return processedText;
        }

    }
}).mount('#app');