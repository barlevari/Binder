// Handle signup form submission
function handleSubmit(event) {
    event.preventDefault();
    
    // Get form data
    const formData = new FormData(event.target);
    const userData = Object.fromEntries(formData.entries());
    
    // Store user data in localStorage (simulating a backend)
    localStorage.setItem('currentUser', JSON.stringify(userData));
    
    // Redirect to match page
    window.location.href = 'match.html';
    return false;
}

// Find a new match (simulated)
function findNewMatch() {
    // Simulated user data
    const matches = [
        {
            name: 'דנה כהן',
            age: 28,
            location: 'תל אביב',
            interests: ['תכנות JavaScript', 'עיצוב UI/UX', 'אנגלית']
        },
        {
            name: 'יוסי לוי',
            age: 32,
            location: 'ירושלים',
            interests: ['תכנות Python', 'מתמטיקה', 'אנגלית']
        },
        {
            name: 'מיכל אברהם',
            age: 25,
            location: 'חיפה',
            interests: ['תכנות React', 'עיצוב גרפי', 'אנגלית']
        }
    ];
    
    // Get random match
    const randomMatch = matches[Math.floor(Math.random() * matches.length)];
    
    // Update match info in the DOM
    const matchInfo = document.querySelector('.match-info');
    if (matchInfo) {
        matchInfo.innerHTML = `
            <h2>${randomMatch.name}</h2>
            <p>גיל: ${randomMatch.age}</p>
            <p>מיקום: ${randomMatch.location}</p>
            <div class="interests">
                <h3>נושאים משותפים:</h3>
                <ul>
                    ${randomMatch.interests.map(interest => `<li>${interest}</li>`).join('')}
                </ul>
            </div>
        `;
    }
}

// Handle chat messages
function sendMessage(event) {
    event.preventDefault();
    
    const messageInput = document.getElementById('messageInput');
    const message = messageInput.value.trim();
    
    if (message) {
        // Add message to chat
        const chatMessages = document.getElementById('chatMessages');
        const messageElement = document.createElement('div');
        messageElement.className = 'message sent';
        messageElement.innerHTML = `<div class="message-content">${message}</div>`;
        chatMessages.appendChild(messageElement);
        
        // Clear input
        messageInput.value = '';
        
        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
        
        // Simulate received message after 1 second
        setTimeout(() => {
            const receivedMessage = document.createElement('div');
            receivedMessage.className = 'message received';
            receivedMessage.innerHTML = `<div class="message-content">תודה על ההודעה! אענה בהקדם.</div>`;
            chatMessages.appendChild(receivedMessage);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }, 1000);
    }
    
    return false;
}

// Initialize chat if on chat page
if (window.location.pathname.includes('chat.html')) {
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
} 