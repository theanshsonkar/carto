# Spec 11 fixture — Rails routes.rb with explicit get/post + resources shorthand.
Rails.application.routes.draw do
  get '/health', to: 'health#index'
  resources :users
end
